import path from 'node:path';
import { config } from '../config.js';

/** Enlaces directos a archivos, solo desde los hosts autorizados en DIRECT_HOSTS. */

const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|ogv|mp3|flac|wav|ogg|oga|m4a|opus)$/i;

export default {
  id: 'direct',
  name: 'Enlace directo',
  match: (url) => config.directHosts.includes(url.hostname) && MEDIA_EXT.test(url.pathname),

  async resolve(url) {
    const file = decodeURIComponent(path.posix.basename(url.pathname));
    return {
      title: file.replace(MEDIA_EXT, '').replace(/[_-]+/g, ' '),
      author: url.hostname,
      thumbnail: null,
      pageUrl: url.href,
      license: null,
      downloadable: true,
      mediaUrl: url.href,
    };
  },
};
