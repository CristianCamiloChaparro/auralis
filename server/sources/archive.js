import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/net.js';

/** Internet Archive: usa la API pública de metadatos; los archivos se ofrecen para descarga. */

const VIDEO_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|mpg|mpeg|ogv)$/i;
const AUDIO_EXT = /\.(mp3|flac|wav|ogg|oga|m4a|opus)$/i;
const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;
const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');

function pickFile(files, wanted) {
  const usable = files.filter(
    (f) => f.private !== 'true' && (VIDEO_EXT.test(f.name) || AUDIO_EXT.test(f.name)),
  );
  if (wanted) return usable.find((f) => f.name === wanted) ?? null;
  const size = (f) => Number(f.size) || 0;
  const rank = (f) =>
    (VIDEO_EXT.test(f.name) ? 2 : 0) + (f.source === 'original' ? 1 : 0);
  return usable.sort((a, b) => rank(b) - rank(a) || size(b) - size(a))[0] ?? null;
}

export default {
  id: 'archive',
  name: 'Internet Archive',
  match: (url) => /^(www\.)?archive\.org$/.test(url.hostname) && /^\/(details|download)\/[^/]+/.test(url.pathname),

  async resolve(url) {
    const [, , identifier, ...rest] = url.pathname.split('/');
    if (!/^[\w.-]{1,100}$/.test(identifier)) {
      throw new AppError('invalid_url', 'El identificador de Internet Archive no es válido.');
    }
    const wanted = url.pathname.startsWith('/download/') && rest.length
      ? decodeURIComponent(rest.join('/'))
      : null;

    const data = await fetchJson(`https://archive.org/metadata/${identifier}`);
    const md = data.metadata;
    if (!md) throw new AppError('not_found', 'No se encontró ese elemento en Internet Archive.', 404);

    const meta = {
      title: first(md.title) ?? identifier,
      author: first(md.creator) ?? first(md.uploader) ?? 'Internet Archive',
      thumbnail: `https://archive.org/services/img/${identifier}`,
      pageUrl: `https://archive.org/details/${identifier}`,
      license: first(md.licenseurl),
    };

    if (data.is_dark || md['access-restricted-item'] === 'true') {
      return { ...meta, downloadable: false, restriction: 'restricted_item' };
    }
    const file = pickFile(data.files ?? [], wanted);
    if (!file) return { ...meta, downloadable: false, restriction: 'no_media' };

    return {
      ...meta,
      downloadable: true,
      mediaUrl: `https://archive.org/download/${identifier}/${encodePath(file.name)}`,
    };
  },
};
