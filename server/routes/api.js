import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { YTDLP } from '../lib/ytdlp.js';
import { analyzeUpload, analyzeUrl, getAnalysis, publicAnalysis } from '../services/analyses.js';
import { cancelJob, createJob, getJob, publicJob } from '../services/jobs.js';

const limiter = (windowMin, max) =>
  rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        error: { code: 'rate_limited', message: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.' },
      }),
  });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID = /^[0-9a-f-]{36}$/i;
const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function apiRouter({ binaries }) {
  const router = express.Router();
  router.use(limiter(5, 600));
  router.param('id', (_req, _res, next, id) =>
    next(UUID.test(id) ? undefined : new AppError('job_not_found', 'Identificador no válido.', 404)),
  );

  router.get('/config', (_req, res) => {
    res.json({
      ready: binaries.ok,
      limits: {
        maxDurationMin: Math.round(config.maxDurationSec / 60),
        maxSourceMB: Math.round(config.maxSourceBytes / 1048576),
        maxUploadMB: Math.round(config.maxUploadBytes / 1048576),
        fileTtlMin: Math.round(config.fileTtlMs / 60000),
      },
      youtubeDownloads: Boolean(YTDLP),
      ytdlpVersion: YTDLP?.version ?? null,
      directHosts: config.directHosts,
      peertube: config.peertubeEnabled,
    });
  });

  router.post(
    '/analyze',
    limiter(1, 20),
    express.json({ limit: '4kb' }),
    wrap(async (req, res) => {
      const analysis = await analyzeUrl(req.body?.url);
      res.json(publicAnalysis(analysis));
    }),
  );

  router.post(
    '/upload',
    limiter(10, 10),
    wrap(async (req, res) => {
      let name = 'archivo';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? name)).slice(0, 200);
      } catch {
        /* nombre no decodificable: se usa el genérico */
      }
      const analysis = await analyzeUpload(req, name);
      res.json(publicAnalysis(analysis));
    }),
  );

  router.post(
    '/jobs',
    limiter(10, 15),
    express.json({ limit: '4kb' }),
    wrap(async (req, res) => {
      const { analysisId, mode, format, quality } = req.body ?? {};
      if (!UUID.test(String(analysisId)) || !['av', 'video', 'audio'].includes(mode)) {
        throw new AppError('invalid_request', 'Solicitud no válida.');
      }
      const job = createJob({
        analysis: getAnalysis(analysisId),
        selection: { mode, format: String(format), quality: String(quality) },
        clientId: req.ip,
      });
      res.status(201).json(publicJob(job));
    }),
  );

  router.get('/jobs/:id', (req, res) => res.json(publicJob(getJob(req.params.id))));

  // Progreso en tiempo real (Server-Sent Events).
  router.get('/jobs/:id/events', (req, res) => {
    const job = getJob(req.params.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (TERMINAL.has(data.status)) close();
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    const close = () => {
      clearInterval(ping);
      job.emitter.off('update', send);
      res.end();
    };
    job.emitter.on('update', send);
    req.on('close', close);
    send(publicJob(job));
  });

  router.delete('/jobs/:id', (req, res) => res.json(publicJob(cancelJob(req.params.id))));

  router.get('/jobs/:id/file', (req, res, next) => {
    const job = getJob(req.params.id);
    if (job.status !== 'done' || !job.outputPath) {
      return next(new AppError('not_ready', 'El archivo todavía no está listo.', 409));
    }
    res.download(job.outputPath, job.filename, (err) => {
      if (err && !res.headersSent) next(new AppError('file_gone', 'El archivo ya no está disponible.', 410));
    });
  });

  router.use((_req, _res, next) => next(new AppError('not_found', 'Recurso no encontrado.', 404)));

  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === 'entity.too.large' || err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_request', message: 'Solicitud no válida.' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Error interno del servidor.' } });
  });

  return router;
}
