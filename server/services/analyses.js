import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { probe } from '../lib/ffmpeg.js';
import { remoteInfo } from '../lib/net.js';
import { buildOptions } from '../lib/options.js';
import { buildYoutubePlan } from '../lib/youtube-plan.js';
import { resolveSource } from '../sources/index.js';

/** Análisis en memoria: relaciona lo que vio el usuario con el origen real a procesar. */
const analyses = new Map();
const uploadsDir = path.join(config.tmpDir, 'uploads');

const resolutionLabel = (v) => (v ? `${v.width}×${v.height}` : null);

function checkLimits(p, size) {
  if (!p.duration) throw new AppError('not_media', 'No se pudo determinar la duración del contenido.', 422);
  if (p.duration > config.maxDurationSec) {
    throw new AppError(
      'too_long',
      `El contenido supera la duración máxima permitida (${Math.round(config.maxDurationSec / 60)} min).`,
      413,
    );
  }
  if (size && size > config.maxSourceBytes) {
    throw new AppError('too_large', 'El archivo supera el tamaño máximo permitido.', 413);
  }
}

function store(record) {
  record.id = randomUUID();
  record.createdAt = Date.now();
  analyses.set(record.id, record);
  return record;
}

/** Vista pública: nunca expone rutas locales ni URLs internas de descarga. */
export function publicAnalysis(a) {
  const p = a.probe;
  return {
    id: a.id,
    downloadable: a.downloadable,
    restriction: a.restriction ?? null,
    source: a.source,
    title: a.title,
    author: a.author,
    thumbnail: a.thumbnail,
    pageUrl: a.pageUrl,
    license: a.license ?? null,
    instance: a.instance ?? null,
    duration: p?.duration ?? a.duration ?? null,
    resolution: p ? resolutionLabel(p.video) : a.resolutionLabel ?? null,
    fps: p?.video?.fps ? Math.round(p.video.fps) : null,
    sourceBytes: a.sourceBytes ?? null,
    hasVideo: Boolean(p?.video),
    hasAudio: Boolean(p?.audio),
    codecs: p ? { video: p.video?.codec ?? null, audio: p.audio?.codec ?? null } : null,
    options: a.options ?? null,
  };
}

export async function analyzeUrl(rawUrl) {
  const meta = await resolveSource(rawUrl);
  if (!meta.downloadable) return store({ ...meta });

  if (meta.ytInfo) {
    const { ytInfo, ...rest } = meta;
    const yt = buildYoutubePlan(ytInfo);
    checkLimits(yt.probe, null);
    if (!yt.options.av.length && !yt.options.video.length && !yt.options.audio) {
      return store({ ...rest, downloadable: false, restriction: 'no_media' });
    }
    return store({
      ...rest,
      probe: yt.probe,
      options: yt.options,
      sourceBytes: yt.sourceBytes,
      input: { type: 'ytdlp', url: rest.pageUrl, plan: yt.plan },
    });
  }

  const info = await remoteInfo(meta.mediaUrl);
  if (info.size && info.size > config.maxSourceBytes) {
    throw new AppError('too_large', 'El archivo supera el tamaño máximo permitido.', 413);
  }
  const p = await probe(info.finalUrl);
  checkLimits(p, info.size);
  return store({
    ...meta,
    probe: p,
    options: buildOptions(p),
    sourceBytes: info.size ?? p.size,
    input: { type: 'remote', url: meta.mediaUrl },
  });
}

/** Recibe un archivo propio del usuario por streaming, con límite estricto de tamaño. */
export async function analyzeUpload(req, filename) {
  const declared = Number(req.headers['content-length']);
  if (declared && declared > config.maxUploadBytes) {
    throw new AppError('too_large', 'El archivo supera el tamaño máximo de subida.', 413);
  }
  await fsp.mkdir(uploadsDir, { recursive: true });
  const dest = path.join(uploadsDir, randomUUID());
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > config.maxUploadBytes) {
        return cb(new AppError('too_large', 'El archivo supera el tamaño máximo de subida.', 413));
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(dest));
    if (!received) throw new AppError('empty_file', 'El archivo está vacío.');
    const p = await probe(dest);
    checkLimits(p, received);
    const base = path.basename(filename || 'archivo').replace(/\.[^.]+$/, '');
    return store({
      downloadable: true,
      source: { id: 'upload', name: 'Archivo propio' },
      title: p.title || base || 'Archivo',
      author: 'Subido desde tu dispositivo',
      thumbnail: null,
      pageUrl: null,
      probe: p,
      options: buildOptions(p),
      sourceBytes: received,
      input: { type: 'file', path: dest },
    });
  } catch (err) {
    await fsp.rm(dest, { force: true });
    if (err instanceof AppError) throw err;
    throw new AppError('upload_failed', 'La subida se interrumpió.', 400);
  }
}

export function getAnalysis(id) {
  const a = analyses.get(id);
  if (!a) throw new AppError('analysis_expired', 'El análisis caducó. Vuelve a analizar el enlace.', 410);
  return a;
}

/** Elimina análisis caducados y sus archivos subidos, salvo que un trabajo los esté usando. */
export async function sweepAnalyses(isInUse) {
  const now = Date.now();
  for (const [id, a] of analyses) {
    if (now - a.createdAt < config.analysisTtlMs || isInUse(id)) continue;
    analyses.delete(id);
    if (a.input?.type === 'file') await fsp.rm(a.input.path, { force: true });
  }
}
