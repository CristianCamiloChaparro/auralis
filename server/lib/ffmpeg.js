import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { AppError } from './errors.js';

// Orden de resolución: variable de entorno → binario empaquetado (npm) → PATH del sistema.
async function resolveBin(envKey, pkg, pick, fallback) {
  if (process.env[envKey]) return process.env[envKey];
  try {
    const mod = await import(pkg);
    const p = pick(mod);
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* paquete opcional no instalado */
  }
  return fallback;
}

export const FFMPEG = await resolveBin('FFMPEG_PATH', 'ffmpeg-static', (m) => m.default, 'ffmpeg');
export const FFPROBE = await resolveBin(
  'FFPROBE_PATH',
  'ffprobe-static',
  (m) => m.default?.path ?? m.path,
  'ffprobe',
);

function version(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out.split('\n')[0].trim() : null));
  });
}

export async function checkBinaries() {
  const [ffmpeg, ffprobe] = await Promise.all([version(FFMPEG), version(FFPROBE)]);
  return { ffmpeg, ffprobe, ok: Boolean(ffmpeg && ffprobe) };
}

const ratio = (s) => {
  if (!s) return null;
  const [a, b] = String(s).split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? v : null;
};
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** Inspecciona un archivo local o una URL https y devuelve sus características reales. */
export function probe(input, { timeoutMs = 45000 } = {}) {
  const remote = /^https:\/\//i.test(input);
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
  if (remote) args.push('-rw_timeout', '20000000', '-protocol_whitelist', 'https,tls,tcp');
  args.push(input);

  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, args, { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new AppError('ffprobe_missing', 'El servidor no tiene ffprobe disponible.', 500));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data;
      try {
        data = JSON.parse(out);
      } catch {
        data = null;
      }
      if (code !== 0 || !data?.streams?.length) {
        return reject(
          new AppError('not_media', 'No se pudo leer el archivo como video o audio válido.', 422),
        );
      }
      const v = data.streams.find(
        (s) => s.codec_type === 'video' && !s.disposition?.attached_pic && s.codec_name !== 'mjpeg' && s.codec_name !== 'png',
      );
      const a = data.streams.find((s) => s.codec_type === 'audio');
      const fmt = data.format ?? {};
      let video = null;
      if (v) {
        const rotation = Math.abs(
          Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0),
        );
        const swap = rotation === 90 || rotation === 270;
        video = {
          codec: v.codec_name,
          width: swap ? v.height : v.width,
          height: swap ? v.width : v.height,
          fps: ratio(v.avg_frame_rate) ?? ratio(v.r_frame_rate),
          bitrate: int(v.bit_rate),
        };
      }
      resolve({
        container: fmt.format_name ?? '',
        duration: Number(fmt.duration) || Number(v?.duration) || Number(a?.duration) || null,
        size: int(fmt.size),
        bitrate: int(fmt.bit_rate),
        title: fmt.tags?.title ?? null,
        video,
        audio: a
          ? {
              codec: a.codec_name,
              bitrate: int(a.bit_rate),
              channels: a.channels || 2,
              sampleRate: int(a.sample_rate) || 44100,
            }
          : null,
      });
    });
  });
}

/**
 * Ejecuta ffmpeg y emite el progreso real leyendo `-progress`.
 * onProgress({ ratio, outputBytes, speed })
 */
export function runFfmpeg(args, { durationSec, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      ['-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1', ...args],
      { windowsHide: true },
    );
    let stderrTail = '';
    let buffer = '';
    const state = {};
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key !== 'progress') {
          state[key] = value;
          continue;
        }
        const us = Number(state.out_time_us ?? state.out_time_ms);
        const seconds = Number.isFinite(us) ? us / 1e6 : 0;
        onProgress?.({
          ratio: durationSec ? Math.max(0, Math.min(1, seconds / durationSec)) : null,
          outputBytes: Number(state.total_size) || 0,
          speed: parseFloat(state.speed) || null,
        });
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new AppError('ffmpeg_missing', 'El servidor no tiene ffmpeg disponible.', 500));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        const e = new Error('cancelado');
        e.name = 'AbortError';
        return reject(e);
      }
      if (code === 0) return resolve();
      const e = new AppError('processing_failed', 'El procesamiento del archivo falló.', 500);
      e.detail = stderrTail;
      reject(e);
    });
  });
}
