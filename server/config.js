import os from 'node:os';
import path from 'node:path';

// Carga opcional de .env (Node >= 20.12 / 21.7). Si no existe, se ignora.
try {
  process.loadEnvFile?.();
} catch {
  /* sin archivo .env */
}

const num = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const list = (key, fallback) =>
  (process.env[key] ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const MB = 1024 * 1024;

export const config = {
  port: num('PORT', 3000),
  trustProxy: process.env.TRUST_PROXY ?? false,
  // Una carpeta por puerto: dos instancias en el mismo equipo no se pisan los temporales.
  tmpDir: process.env.TMP_DIR || path.join(os.tmpdir(), 'auralis', `puerto-${num('PORT', 3000)}`),

  // Límites
  maxDurationSec: num('MAX_DURATION_MIN', 180) * 60,
  maxSourceBytes: num('MAX_SOURCE_MB', 2048) * MB,
  maxUploadBytes: num('MAX_UPLOAD_MB', 1024) * MB,
  maxConcurrentJobs: num('MAX_CONCURRENT_JOBS', 2),
  maxJobsPerClient: num('MAX_JOBS_PER_CLIENT', 2),
  maxQueue: num('MAX_QUEUE', 20),
  fileTtlMs: num('FILE_TTL_MIN', 30) * 60 * 1000,
  analysisTtlMs: num('ANALYSIS_TTL_MIN', 60) * 60 * 1000,

  // Identificación ante las fuentes. Algunas (p. ej. Wikimedia) piden incluir un contacto.
  userAgent: process.env.HTTP_USER_AGENT || 'Auralis/1.0 (conversor de medios; fuentes con descarga permitida)',

  // Fuentes
  // Descarga de YouTube mediante yt-dlp. Pon YOUTUBE_DOWNLOADS=false para mostrar solo información.
  youtubeDownloads: (process.env.YOUTUBE_DOWNLOADS ?? 'true') !== 'false',
  peertubeEnabled: (process.env.PEERTUBE_ENABLED ?? 'true') !== 'false',
  // Hosts de los que se aceptan enlaces directos a archivos (tu propio hosting, CDN, etc.)
  directHosts: list('DIRECT_HOSTS', 'upload.wikimedia.org'),
};
