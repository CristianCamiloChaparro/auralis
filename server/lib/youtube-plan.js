import { buildOptions, estimateVideoBytes, qualityLabel } from './options.js';

/**
 * A partir de la lista de formatos de yt-dlp decide qué opciones ofrecer y
 * qué flujos exactos descargar para cada una. Solo aparecen las resoluciones
 * que YouTube realmente tiene para ese video.
 */

const size = (f) => f.filesize || f.filesize_approx || 0;
const isHttp = (f) => /^https?$/.test(f.protocol ?? '');
const codecFamily = (vcodec = '') =>
  vcodec.startsWith('avc1') ? 'h264' : vcodec.startsWith('vp') ? 'vp9' : vcodec.startsWith('av01') ? 'av1' : vcodec;

function qualityOf(f) {
  const note = /(\d{3,4})p/.exec(f.format_note ?? '');
  if (note) return Number(note[1]);
  return Math.min(f.width || Infinity, f.height || Infinity);
}

function pickAudio(formats, preferAac) {
  const audio = formats.filter(
    (f) =>
      f.vcodec === 'none' &&
      f.acodec && f.acodec !== 'none' &&
      !/drc/i.test(f.format_id) &&
      (f.audio_channels ?? 2) <= 2 &&
      !/iamf/i.test(f.acodec),
  );
  const score = (f) =>
    (preferAac && f.acodec.startsWith('mp4a') ? 1e6 : 0) + (isHttp(f) ? 1e5 : 0) + (f.abr || f.tbr || 0);
  return audio.sort((a, b) => score(b) - score(a))[0] ?? null;
}

function pickVideoByQuality(formats) {
  const byQ = new Map();
  const pref = { h264: 3, vp9: 2, av1: 1 };
  for (const f of formats) {
    if (!f.vcodec || f.vcodec === 'none' || (f.acodec && f.acodec !== 'none')) continue;
    if (!f.width || !f.height) continue;
    const q = qualityOf(f);
    const fam = codecFamily(f.vcodec);
    if (!pref[fam]) continue;
    const score = (f.fps || 30) * 1000 + (isHttp(f) ? 100 : 0) + pref[fam] * 10;
    const prev = byQ.get(q);
    if (!prev || score > prev.score) byQ.set(q, { f, score, fam });
  }
  return [...byQ.entries()].sort((a, b) => b[0] - a[0]);
}

export function buildYoutubePlan(info) {
  const duration = Number(info.duration) || null;
  const formats = info.formats ?? [];
  const aac = pickAudio(formats, true);
  const bestAudio = pickAudio(formats, false);
  const videos = pickVideoByQuality(formats);
  const top = videos[0]?.[1].f;

  // "probe" equivalente al de ffprobe, construido con los datos de YouTube.
  const probe = {
    duration,
    size: null,
    bitrate: null,
    title: info.title,
    video: top
      ? { codec: codecFamily(top.vcodec), width: top.width, height: top.height, fps: top.fps || null, bitrate: null }
      : null,
    audio: bestAudio
      ? {
          codec: bestAudio.acodec.startsWith('mp4a') ? 'aac' : bestAudio.acodec,
          bitrate: bestAudio.abr ? Math.round(bestAudio.abr * 1000) : null,
          channels: bestAudio.audio_channels || 2,
          sampleRate: bestAudio.asr || 48000,
        }
      : null,
  };

  const plan = {};
  const options = { av: [], video: [], audio: null, lossySource: true };

  for (const [q, { f, fam }] of videos) {
    const copy = fam === 'h264';
    const vBytes = copy ? size(f) : estimateVideoBytes(q, duration, size(f));
    const label = qualityLabel(q);
    const original = f === top;
    if (aac) {
      options.av.push({ format: 'mp4', quality: String(q), label, original, estBytes: vBytes + size(aac) || null });
      plan[`av:${q}`] = {
        ids: `${f.format_id}+${aac.format_id}`,
        bytes: size(f) + size(aac) || null,
        copy,
        weight: copy ? 0.92 : 0.3,
      };
    }
    options.video.push({ format: 'mp4', quality: String(q), label, original, estBytes: vBytes || null });
    plan[`video:${q}`] = { ids: f.format_id, bytes: size(f) || null, copy, weight: copy ? 0.92 : 0.3 };
  }

  if (bestAudio) {
    options.audio = buildOptions({ ...probe, video: null }).audio;
    plan.audio = { ids: bestAudio.format_id, bytes: size(bestAudio) || null, weight: 0.5 };
  }

  const sourceBytes = top && aac ? size(top) + size(aac) : size(top ?? bestAudio ?? {});
  return { probe, options, plan, sourceBytes: sourceBytes || null };
}

export const planKey = (mode, quality) => (mode === 'audio' ? 'audio' : `${mode}:${quality}`);
