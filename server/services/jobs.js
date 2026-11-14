import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { probe, runFfmpeg } from '../lib/ffmpeg.js';
import { downloadToFile } from '../lib/net.js';
import { buildFfmpegArgs, findOption } from '../lib/options.js';
import { planKey } from '../lib/youtube-plan.js';
import { download as ytdlpDownload } from '../lib/ytdlp.js';

/**
 * Cola de trabajos en memoria con concurrencia limitada.
 * Estados: queued → downloading → processing → done | error | cancelled
 * Para escalar a varios procesos, sustituir este módulo por una cola externa
 * (p. ej. BullMQ) manteniendo la misma interfaz.
 */

const jobs = new Map();
const queue = [];
let running = 0;

const ACTIVE = new Set(['queued', 'downloading', 'processing']);
const DOWNLOAD_WEIGHT = 0.35; // parte del progreso total que corresponde a traer el origen

const MODE_LABEL = { av: 'Video con audio', video: 'Solo video', audio: 'Solo audio' };

function safeName(title) {
  const clean = String(title)
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || 'archivo';
}

export function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    percent: Math.round(job.percent * 10) / 10,
    stagePercent: Math.round(job.stagePercent * 10) / 10,
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    downloadedBytes: job.downloadedBytes,
    sourceBytes: job.sourceBytes,
    outputBytes: job.outputBytes,
    speed: job.speed,
    title: job.title,
    mode: job.mode,
    modeLabel: MODE_LABEL[job.mode],
    format: job.option.format,
    qualityLabel: job.option.label,
    filename: job.filename,
    error: job.error,
    expiresAt: job.expiresAt,
  };
}

function update(job, patch) {
  Object.assign(job, patch);
  job.emitter.emit('update', publicJob(job));
}

export function createJob({ analysis, selection, clientId }) {
  if (!analysis.downloadable || !analysis.input) {
    throw new AppError('not_downloadable', 'Este contenido no se puede descargar desde su fuente.', 403);
  }
  const option = findOption(analysis.options, selection);
  const mine = [...jobs.values()].filter((j) => j.clientId === clientId && ACTIVE.has(j.status));
  if (mine.length >= config.maxJobsPerClient) {
    throw new AppError('too_many_jobs', 'Ya tienes operaciones en curso. Espera a que terminen o cancélalas.', 429);
  }
  if (queue.length >= config.maxQueue) {
    throw new AppError('server_busy', 'El servidor está ocupado. Inténtalo de nuevo en unos minutos.', 503);
  }

  const suffix = selection.mode === 'audio' ? option.quality.replace(/\D+/g, '') : `${option.quality}p`;
  const job = {
    id: randomUUID(),
    clientId,
    analysisId: analysis.id,
    status: 'queued',
    percent: 0,
    stagePercent: 0,
    downloadedBytes: 0,
    sourceBytes: analysis.sourceBytes ?? null,
    outputBytes: 0,
    speed: null,
    title: analysis.title,
    mode: selection.mode,
    option,
    probe: analysis.probe,
    input: analysis.input,
    filename: `${safeName(analysis.title)}${suffix ? ` (${suffix}${selection.mode === 'audio' && option.format === 'mp3' ? 'kbps' : ''})` : ''}${selection.mode === 'video' ? ' sin audio' : ''}.${option.format}`,
    error: null,
    expiresAt: null,
    createdAt: Date.now(),
    finishedAt: null,
    outputPath: null,
    abort: new AbortController(),
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(20);
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < config.maxConcurrentJobs && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
  // Los que siguen en cola reciben su nueva posición.
  for (const j of queue) j.emitter.emit('update', publicJob(j));
}

async function run(job) {
  const dir = path.join(config.tmpDir, 'jobs', job.id);
  const { signal } = job.abort;
  try {
    await fsp.mkdir(dir, { recursive: true });
    let input = job.input.path;
    let media = job.probe;
    let option = job.option;
    const remote = job.input.type !== 'file';
    let weight = DOWNLOAD_WEIGHT;

    if (job.input.type === 'ytdlp') {
      const step = job.input.plan[planKey(job.mode, job.option.quality)];
      if (!step) throw new AppError('invalid_option', 'La opción seleccionada no está disponible.', 400);
      if (step.bytes && step.bytes > config.maxSourceBytes) {
        throw new AppError('too_large', 'El archivo supera el tamaño máximo permitido.', 413);
      }
      weight = step.weight;
      const total = step.bytes;
      update(job, { status: 'downloading', sourceBytes: total });
      let last = 0;
      input = await ytdlpDownload(job.input.url, step.ids, dir, {
        signal,
        onProgress: (done) => {
          const now = Date.now();
          if (now - last < 250) return;
          last = now;
          const ratio = total ? Math.min(1, done / total) : 0;
          update(job, { downloadedBytes: done, stagePercent: ratio * 100, percent: ratio * weight * 100 });
        },
        onMerging: () => update(job, { stagePercent: 100, percent: weight * 100 }),
      });
      // Ya se descargó exactamente la calidad elegida: se procesa a su tamaño nativo.
      media = await probe(input);
      option = { ...option, original: true };
      update(job, { downloadedBytes: total ?? job.downloadedBytes, stagePercent: 100, percent: weight * 100 });
    } else if (remote) {
      update(job, { status: 'downloading' });
      input = path.join(dir, 'source');
      await downloadToFile(job.input.url, input, {
        maxBytes: config.maxSourceBytes,
        signal,
        onProgress: (done, total) => {
          const ratio = total ? Math.min(1, done / total) : 0;
          update(job, {
            downloadedBytes: done,
            sourceBytes: total ?? job.sourceBytes,
            stagePercent: ratio * 100,
            percent: ratio * weight * 100,
          });
        },
      });
    }

    const base = remote ? weight : 0;
    update(job, { status: 'processing', stagePercent: 0, percent: base * 100 });
    const output = path.join(dir, `output.${option.format}`);
    await runFfmpeg(buildFfmpegArgs(media, job.mode, option, input, output), {
      durationSec: media.duration,
      signal,
      onProgress: ({ ratio, outputBytes, speed }) => {
        const r = ratio ?? 0;
        update(job, {
          outputBytes,
          speed,
          stagePercent: r * 100,
          percent: (base + r * (1 - base)) * 100,
        });
      },
    });

    if (remote) await fsp.rm(input, { force: true });
    const { size } = await fsp.stat(output);
    job.outputPath = output;
    job.finishedAt = Date.now();
    update(job, {
      status: 'done',
      percent: 100,
      stagePercent: 100,
      outputBytes: size,
      expiresAt: job.finishedAt + config.fileTtlMs,
    });
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    job.finishedAt = Date.now();
    if (signal.aborted) {
      update(job, { status: 'cancelled' });
    } else {
      if (!(err instanceof AppError)) console.error(`[job ${job.id}]`, err);
      else if (err.detail) console.error(`[job ${job.id}]`, err.detail);
      update(job, {
        status: 'error',
        error: err instanceof AppError ? err.message : 'Ocurrió un error inesperado al procesar el archivo.',
      });
    }
  }
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw new AppError('job_not_found', 'La operación no existe o ya caducó.', 404);
  return job;
}

export function cancelJob(id) {
  const job = getJob(id);
  if (!ACTIVE.has(job.status)) return job;
  const queued = queue.indexOf(job);
  job.abort.abort();
  if (queued >= 0) {
    queue.splice(queued, 1);
    job.finishedAt = Date.now();
    update(job, { status: 'cancelled' });
  }
  return job;
}

export const isAnalysisInUse = (analysisId) =>
  [...jobs.values()].some((j) => j.analysisId === analysisId && ACTIVE.has(j.status));

/** Borra archivos y registros de trabajos terminados cuyo plazo venció. */
export async function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (ACTIVE.has(job.status) || now - job.finishedAt < config.fileTtlMs) continue;
    jobs.delete(id);
    await fsp.rm(path.join(config.tmpDir, 'jobs', id), { recursive: true, force: true }).catch(() => {});
  }
}

export function cancelAll() {
  for (const job of jobs.values()) if (ACTIVE.has(job.status)) job.abort.abort();
}
