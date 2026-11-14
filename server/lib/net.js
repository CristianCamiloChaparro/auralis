import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { AppError } from './errors.js';

const USER_AGENT = config.userAgent;

// Rangos no públicos: se bloquean para evitar SSRF contra la red interna.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
]) blocked.addSubnet(addr, prefix, 'ipv6');

function isPublicIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Valida que la URL sea https, sin credenciales, puerto estándar y host público. */
export async function assertPublicUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new AppError('invalid_url', 'El enlace no es una URL válida.');
  }
  if (url.protocol !== 'https:') {
    throw new AppError('invalid_url', 'Solo se aceptan enlaces https.');
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('invalid_url', 'El enlace contiene credenciales o un puerto no permitido.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new AppError('host_unreachable', 'No se pudo resolver el dominio del enlace.', 502);
    }
  }
  if (!addresses.length || !addresses.every(isPublicIp)) {
    throw new AppError('forbidden_host', 'El enlace apunta a una dirección no permitida.', 403);
  }
  return url;
}

/** fetch con redirecciones manuales: cada salto se valida de nuevo. */
export async function safeFetch(url, init = {}, maxRedirects = 5) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current);
    let res;
    try {
      res = await fetch(current, {
        ...init,
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, ...init.headers },
      });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
      throw new AppError('upstream_unreachable', 'No se pudo conectar con la fuente.', 502);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) break;
      current = new URL(location, current).href;
      continue;
    }
    return { res, url: current };
  }
  throw new AppError('too_many_redirects', 'La fuente redirige demasiadas veces.', 502);
}

export async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  let res;
  try {
    ({ res } = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    }));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('upstream_timeout', 'La fuente tardó demasiado en responder.', 504);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const e = new AppError('upstream_error', `La fuente respondió con un error (${res.status}).`, 502);
    e.upstreamStatus = res.status;
    throw e;
  }
  try {
    return await res.json();
  } catch {
    throw new AppError('upstream_error', 'La fuente devolvió una respuesta inesperada.', 502);
  }
}

/** Resuelve redirecciones y obtiene el tamaño real del archivo remoto. */
export async function remoteInfo(url) {
  let out;
  try {
    out = await fetchMedia(url, {
      headers: { range: 'bytes=0-0' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('upstream_timeout', 'La fuente tardó demasiado en responder.', 504);
  }
  const { res, url: finalUrl } = out;
  await res.body?.cancel().catch(() => {});
  let size = null;
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
  if (range) size = Number(range[1]);
  else if (res.status === 200 && res.headers.get('content-length')) {
    size = Number(res.headers.get('content-length'));
  }
  return { finalUrl, size, type: res.headers.get('content-type') || '' };
}

/**
 * Petición de un archivo multimedia. Si la fuente pide esperar (429/503),
 * se respeta su `Retry-After` y se reintenta un par de veces.
 */
async function fetchMedia(url, init = {}, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const out = await safeFetch(url, init);
    const { res } = out;
    if (res.ok) return out;
    await res.body?.cancel().catch(() => {});
    const busy = res.status === 429 || res.status === 503;
    if (busy && attempt < retries) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 3 * (attempt + 1), 15);
      await sleep(wait * 1000, undefined, { signal: init.signal });
      continue;
    }
    if (busy) {
      throw new AppError(
        'source_busy',
        'La fuente está limitando las descargas en este momento. Espera unos minutos e inténtalo de nuevo.',
        503,
      );
    }
    throw new AppError('media_unavailable', `El archivo no está disponible en la fuente (${res.status}).`, 502);
  }
}

/** Descarga a disco con límite de tamaño, cancelación y progreso real en bytes. */
export async function downloadToFile(url, dest, { maxBytes, signal, onProgress } = {}) {
  const { res } = await fetchMedia(url, { signal });
  if (!res.body) throw new AppError('media_unavailable', 'La fuente no devolvió el archivo.', 502);
  const total = Number(res.headers.get('content-length')) || null;
  if (maxBytes && total && total > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new AppError('too_large', 'El archivo supera el tamaño máximo permitido.', 413);
  }
  let done = 0;
  let lastEmit = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (maxBytes && done > maxBytes) {
        return cb(new AppError('too_large', 'El archivo supera el tamaño máximo permitido.', 413));
      }
      const now = Date.now();
      if (onProgress && now - lastEmit > 250) {
        lastEmit = now;
        onProgress(done, total);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest), { signal });
  onProgress?.(done, total ?? done);
  return done;
}
