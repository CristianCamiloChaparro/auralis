import { AppError } from '../lib/errors.js';
import archive from './archive.js';
import direct from './direct.js';
import peertube from './peertube.js';
import wikimedia from './wikimedia.js';
import youtube from './youtube.js';

// Para añadir una fuente nueva basta con crear su módulo { id, name, match, resolve } y sumarlo aquí.
// PeerTube va al final porque se reconoce por la forma de la ruta, no por el dominio.
const SOURCES = [youtube, archive, wikimedia, direct, peertube];

export function parseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) {
    throw new AppError('invalid_url', 'Pega un enlace válido.');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError('invalid_url', 'El enlace no es una URL válida.');
  }
  if (url.protocol !== 'https:') {
    throw new AppError('invalid_url', 'Solo se aceptan enlaces https.');
  }
  return url;
}

/** Devuelve los metadatos de la fuente; lanza `unsupported_source` si no está en la lista. */
export async function resolveSource(raw) {
  const url = parseUrl(raw);
  const source = SOURCES.find((s) => s.match(url));
  if (!source) {
    throw new AppError(
      'unsupported_source',
      'Esta fuente no está en la lista de sitios permitidos. Si el video es tuyo, puedes subir el archivo.',
    );
  }
  const meta = await source.resolve(url);
  return { ...meta, source: { id: source.id, name: source.name } };
}
