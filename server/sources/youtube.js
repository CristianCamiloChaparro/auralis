import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/net.js';
import { getInfo, YTDLP } from '../lib/ytdlp.js';

/**
 * YouTube. Con yt-dlp disponible se obtienen los formatos reales y se permite
 * la descarga. Sin yt-dlp se recurre a oEmbed y solo se muestra información.
 */

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtube-nocookie.com',
]);
const ID = /^[\w-]{11}$/;

function videoId(url) {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0];
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
  return m?.[1] ?? null;
}

async function metadataOnly(id, pageUrl) {
  let oembed;
  try {
    oembed = await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(pageUrl)}`);
  } catch (err) {
    if ([400, 401, 403, 404].includes(err.upstreamStatus)) {
      throw new AppError('not_found', 'El video no existe, es privado o no permite ser insertado.', 404);
    }
    throw err;
  }
  return {
    title: oembed.title,
    author: oembed.author_name,
    thumbnail: oembed.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    pageUrl,
    duration: null,
    license: null,
    downloadable: false,
    restriction: 'ytdlp_missing',
  };
}

export default {
  id: 'youtube',
  name: 'YouTube',
  match: (url) => HOSTS.has(url.hostname),

  async resolve(url) {
    const id = videoId(url);
    if (!id || !ID.test(id)) {
      throw new AppError('invalid_url', 'El enlace de YouTube no corresponde a un video.');
    }
    const pageUrl = `https://www.youtube.com/watch?v=${id}`;
    if (!YTDLP) return metadataOnly(id, pageUrl);

    const info = await getInfo(pageUrl);
    const meta = {
      title: info.title,
      author: info.channel ?? info.uploader ?? 'YouTube',
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      pageUrl,
      duration: info.duration ?? null,
      license: info.license ?? null,
    };
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      return { ...meta, downloadable: false, restriction: 'live' };
    }
    return { ...meta, downloadable: true, ytInfo: info };
  },
};
