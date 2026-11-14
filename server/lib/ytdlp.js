import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError } from './errors.js';
import { FFMPEG } from './ffmpeg.js';

/**
 * Integración con yt-dlp (https://github.com/yt-dlp/yt-dlp).
 * Orden de búsqueda: YTDLP_PATH → `yt-dlp` en el PATH → `python -m yt_dlp`.
 */

function tryVersion(cmd, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, [...args, '--version'], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

async function locate() {
  const candidates = [];
  if (process.env.YTDLP_PATH) candidates.push([process.env.YTDLP_PATH, []]);
  candidates.push(['yt-dlp', []], ['python', ['-m', 'yt_dlp']], ['python3', ['-m', 'yt_dlp']]);
  for (const [cmd, args] of candidates) {
    const version = await tryVersion(cmd, args);
    if (version) return { cmd, args, version };
  }
  return null;
}

export const YTDLP = config.youtubeDownloads ? await locate() : null;

// Opciones comunes: ignora configuraciones del sistema y usa Node como intérprete JS.
const BASE = ['--ignore-config', '--no-playlist', '--no-warnings', '--js-runtimes', 'node'];

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function run(extraArgs, { signal, timeoutMs, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP.cmd, [...YTDLP.args, ...BASE, ...extraArgs], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => ((timedOut = true), killTree(child)), timeoutMs) : null;
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      if (!onLine) {
        stdout += chunk;
        return;
      }
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', () => reject(new AppError('ytdlp_missing', 'El servidor no tiene yt-dlp disponible.', 500)));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        const e = new Error('cancelado');
        e.name = 'AbortError';
        return reject(e);
      }
      if (timedOut) return reject(new AppError('upstream_timeout', 'YouTube tardó demasiado en responder.', 504));
      if (code === 0) return resolve(stdout);
      reject(translateError(stderr));
    });
  });
}

/** Convierte los errores de yt-dlp en mensajes comprensibles. */
function translateError(stderr) {
  const msg = (stderr.match(/ERROR: (.*)/g) ?? []).pop() ?? stderr;
  const rules = [
    [/private video/i, 'not_found', 'El video es privado.', 404],
    [/confirm your age|age-restricted|inappropriate for some users/i, 'age_restricted', 'El video tiene restricción de edad y requiere iniciar sesión en YouTube.', 403],
    [/not a bot|sign in to confirm/i, 'source_blocked', 'YouTube está pidiendo verificación a este servidor. Inténtalo más tarde.', 503],
    [/members-only|join this channel/i, 'members_only', 'El video es exclusivo para miembros del canal.', 403],
    [/not available in your country|geo.?restrict/i, 'geo_blocked', 'El video no está disponible en la región del servidor.', 403],
    [/premieres in|live event will begin|is_upcoming/i, 'live', 'El video todavía no se ha estrenado.', 409],
    [/video (is )?unavailable|has been removed|does not exist|404/i, 'not_found', 'El video no existe o fue eliminado.', 404],
    [/drm/i, 'drm', 'El video está protegido con DRM y no se puede descargar.', 403],
    [/File is larger than max-filesize/i, 'too_large', 'El archivo supera el tamaño máximo permitido.', 413],
    [/HTTP Error 403/i, 'source_forbidden', 'YouTube rechazó la descarga temporalmente. Vuelve a intentarlo en unos segundos.', 503],
    [/HTTP Error 429|too many requests/i, 'source_busy', 'YouTube está limitando las solicitudes. Espera unos minutos.', 503],
  ];
  for (const [re, code, text, status] of rules) if (re.test(msg)) return new AppError(code, text, status);
  const e = new AppError('youtube_failed', 'No se pudo obtener el video de YouTube.', 502);
  e.detail = msg;
  console.error('[yt-dlp]', msg.trim());
  return e;
}

/** Metadatos y lista completa de formatos. */
export async function getInfo(url) {
  const out = await run(['-J', '--', url], { timeoutMs: 60000 });
  try {
    return JSON.parse(out);
  } catch {
    throw new AppError('youtube_failed', 'YouTube devolvió una respuesta inesperada.', 502);
  }
}

const PROGRESS = 'AUR %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s';

/**
 * Descarga los formatos indicados (p. ej. "299+140") en `dir/source.<ext>`.
 * onProgress(bytesTotalesDescargados) con bytes reales acumulados entre flujos.
 */
export async function download(url, formatIds, dir, opts = {}) {
  // YouTube a veces responde 403 a un enlace de descarga concreto; volver a
  // extraer genera enlaces nuevos y suele bastar.
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadOnce(url, formatIds, dir, opts);
    } catch (err) {
      if (err.code !== 'source_forbidden' || attempt >= 2 || opts.signal?.aborted) throw err;
      for (const f of await fsp.readdir(dir)) await fsp.rm(path.join(dir, f), { force: true });
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function downloadOnce(url, formatIds, dir, { signal, onProgress, onMerging } = {}) {
  let completed = 0; // bytes de los flujos ya terminados
  let current = 0;
  await run(
    [
      '-f', formatIds,
      '-o', path.join(dir, 'source.%(ext)s'),
      '--merge-output-format', 'mkv',
      // Solo una ruta absoluta; si es un nombre, yt-dlp lo busca en el PATH.
      ...(path.isAbsolute(FFMPEG) ? ['--ffmpeg-location', FFMPEG] : []),
      '--max-filesize', String(config.maxSourceBytes),
      '--no-mtime', '--no-part', '--newline',
      '--progress-template', `download:${PROGRESS}`,
      '--', url,
    ],
    {
      signal,
      onLine: (line) => {
        if (line.startsWith('[Merger]')) return onMerging?.();
        const m = /^AUR (\S+) (\S+) (\S+) (\S+)/.exec(line);
        if (!m) return;
        const done = Number(m[2]) || 0;
        if (done < current) completed += current; // empezó el siguiente flujo
        current = done;
        if (m[1] === 'finished') {
          completed += current;
          current = 0;
        }
        onProgress?.(completed + current);
      },
    },
  );
  const files = await fsp.readdir(dir);
  const file = files.find((f) => f.startsWith('source.') && !/\.(part|ytdl|temp)$/.test(f) && !/\.f\d+/.test(f));
  if (!file) {
    // Flujos sueltos sin fusionar: yt-dlp no encontró ffmpeg.
    const e = new AppError('processing_failed', 'No se pudieron combinar el video y el audio.', 500);
    e.detail = `archivos sin fusionar: ${files.join(', ')}`;
    throw e;
  }
  return path.join(dir, file);
}
