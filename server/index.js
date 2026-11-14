import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { checkBinaries } from './lib/ffmpeg.js';
import { YTDLP } from './lib/ytdlp.js';
import { apiRouter } from './routes/api.js';
import { sweepAnalyses } from './services/analyses.js';
import { cancelAll, isAnalysisInUse, sweepJobs } from './services/jobs.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Arranque limpio: cualquier temporal de una ejecución anterior se descarta.
await fsp.rm(config.tmpDir, { recursive: true, force: true });
await fsp.mkdir(config.tmpDir, { recursive: true });

const binaries = await checkBinaries();
if (!binaries.ok) {
  console.warn('⚠  No se encontró ffmpeg/ffprobe. Instálalos o define FFMPEG_PATH y FFPROBE_PATH.');
}

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy === 'true' ? 1 : config.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use('/api', apiRouter({ binaries }));
app.use(express.static(publicDir, { extensions: ['html'] }));
app.use((_req, res) => res.status(404).sendFile(path.join(publicDir, 'index.html')));

const sweeper = setInterval(() => {
  sweepJobs().catch(console.error);
  sweepAnalyses(isAnalysisInUse).catch(console.error);
}, 60_000);
sweeper.unref();

const server = app.listen(config.port, () => {
  console.log(`Auralis listo en http://localhost:${config.port}`);
  console.log(`  ffmpeg: ${binaries.ffmpeg ?? 'no disponible'}`);
  console.log(`  yt-dlp: ${YTDLP ? YTDLP.version : 'no disponible (YouTube solo mostrará información)'}`);
  console.log(`  temporales: ${config.tmpDir}`);
});

async function shutdown() {
  cancelAll();
  server.close();
  await fsp.rm(config.tmpDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
