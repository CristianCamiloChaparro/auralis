import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/net.js';

/**
 * PeerTube: red federada de software libre. Su API pública indica si el autor
 * habilitó la descarga (`downloadEnabled`); solo en ese caso se ofrece.
 */

const PATH = /^\/(?:w|videos\/watch|videos\/embed)\/([\w-]{8,64})$/;

export default {
  id: 'peertube',
  name: 'PeerTube',
  match: (url) => config.peertubeEnabled && PATH.test(url.pathname),

  async resolve(url) {
    const id = PATH.exec(url.pathname)[1];
    let v;
    try {
      v = await fetchJson(`https://${url.hostname}/api/v1/videos/${id}`);
    } catch (err) {
      if (err.upstreamStatus === 404) throw new AppError('not_found', 'El video no existe o no es público.', 404);
      throw new AppError('unsupported_source', 'Este sitio no es una fuente compatible.', 400);
    }
    if (!v?.uuid || !v.name) {
      throw new AppError('unsupported_source', 'Este sitio no es una fuente compatible.', 400);
    }

    const meta = {
      title: v.name,
      author: v.channel?.displayName ?? v.account?.displayName ?? url.hostname,
      thumbnail: v.previewPath ? `https://${url.hostname}${v.previewPath}` : null,
      pageUrl: `https://${url.hostname}/w/${v.shortUUID ?? v.uuid}`,
      license: v.licence?.label ?? null,
      instance: url.hostname,
    };
    if (v.isLive) return { ...meta, downloadable: false, restriction: 'live' };
    if (!v.downloadEnabled) return { ...meta, downloadable: false, restriction: 'owner_disabled' };

    const files = [...(v.files ?? []), ...(v.streamingPlaylists ?? []).flatMap((p) => p.files ?? [])]
      .filter((f) => f.fileDownloadUrl)
      .sort((a, b) => (b.resolution?.id ?? 0) - (a.resolution?.id ?? 0));
    if (!files.length) return { ...meta, downloadable: false, restriction: 'no_media' };

    return { ...meta, downloadable: true, mediaUrl: files[0].fileDownloadUrl };
  },
};
