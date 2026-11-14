import { AppError } from '../lib/errors.js';
import { fetchJson } from '../lib/net.js';

/** Wikimedia Commons: contenido con licencias libres, consultado por su API oficial. */

const stripHtml = (s) => (s ? String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null);

export default {
  id: 'wikimedia',
  name: 'Wikimedia Commons',
  match: (url) =>
    url.hostname === 'commons.wikimedia.org' &&
    (/^\/wiki\/File:/i.test(url.pathname) || /File:/i.test(url.hash)),

  async resolve(url) {
    let title;
    const inHash = /File:[^&]+/i.exec(decodeURIComponent(url.hash));
    if (inHash) title = inHash[0];
    else title = decodeURIComponent(url.pathname.replace(/^\/wiki\//, ''));
    title = title.replace(/_/g, ' ');

    const api = new URL('https://commons.wikimedia.org/w/api.php');
    api.search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      titles: title,
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: '640',
    });
    const data = await fetchJson(api.href);
    const page = data.query?.pages?.[0];
    const info = page?.imageinfo?.[0];
    if (!info) throw new AppError('not_found', 'No se encontró ese archivo en Wikimedia Commons.', 404);

    const ext = info.extmetadata ?? {};
    const meta = {
      title: stripHtml(ext.ObjectName?.value) ?? title.replace(/^File:/i, '').replace(/\.\w+$/, ''),
      author: stripHtml(ext.Artist?.value) ?? 'Wikimedia Commons',
      thumbnail: /^(video)\//.test(info.mime) ? info.thumburl ?? null : null,
      pageUrl: info.descriptionurl ?? url.href,
      license: stripHtml(ext.LicenseShortName?.value),
    };
    if (!/^(video|audio)\//.test(info.mime) && info.mime !== 'application/ogg') {
      return { ...meta, downloadable: false, restriction: 'no_media' };
    }
    return { ...meta, downloadable: true, mediaUrl: info.url };
  },
};
