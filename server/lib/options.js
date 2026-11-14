import { AppError } from './errors.js';

/**
 * A partir de las características reales del archivo (ffprobe) calcula qué
 * opciones de descarga existen de verdad y cómo producir cada una con ffmpeg.
 * Nunca se ofrece una resolución superior a la del original.
 */

const LADDER = [
  { h: 144, label: '144p' },
  { h: 240, label: '240p' },
  { h: 360, label: '360p' },
  { h: 480, label: '480p' },
  { h: 720, label: '720p HD' },
  { h: 1080, label: '1080p Full HD' },
  { h: 1440, label: '1440p 2K' },
  { h: 2160, label: '2160p 4K' },
];
// Bitrate de video aproximado (kbps) para H.264 CRF 23; solo se usa para estimar tamaños.
const VIDEO_KBPS = { 144: 120, 240: 280, 360: 550, 480: 950, 720: 2200, 1080: 4200, 1440: 8500, 2160: 17000 };
const MP3_KBPS = [320, 256, 192, 128, 96];
const LOSSLESS = /^(flac|alac|pcm_|wavpack|ape|tta)/;
const AAC_KBPS = 160;

const videoKbps = (h) => VIDEO_KBPS[h] ?? Math.round(4200 * (h / 1080) ** 1.6);
const bytes = (kbps, seconds) => Math.round((kbps * 1000 * seconds) / 8);

export const qualityLabel = (h) => LADDER.find((l) => l.h === h)?.label ?? `${h}p`;

/** Tamaño estimado de un video recodificado a H.264, sin superar el del origen si se conoce. */
export function estimateVideoBytes(h, seconds, sourceBytes) {
  if (!seconds) return null;
  const est = bytes(videoKbps(h), seconds);
  return sourceBytes ? Math.min(est, sourceBytes) : est;
}

function videoQualities(p) {
  const short = Math.min(p.video.width, p.video.height);
  const list = LADDER.filter((l) => l.h <= short * 1.03).map((l) => ({ ...l }));
  if (!list.length || list.at(-1).h < short * 0.9) {
    list.push({ h: short, label: `${short}p` });
  }
  list.at(-1).original = true;
  return list.reverse();
}

function estimateVideo(p, q, withAudio) {
  if (!p.duration) return null;
  const copyVideo = q.original && p.video.codec === 'h264';
  let vBytes;
  if (copyVideo) {
    const srcVideoBps =
      p.video.bitrate ?? (p.bitrate ? p.bitrate - (p.audio?.bitrate ?? 0) : null);
    vBytes = srcVideoBps ? (srcVideoBps * p.duration) / 8 : bytes(videoKbps(q.h), p.duration);
  } else {
    vBytes = bytes(videoKbps(q.h), p.duration);
    // Reducir resolución no debería pesar más que el original.
    if (p.size) vBytes = Math.min(vBytes, p.size);
  }
  let aBytes = 0;
  if (withAudio && p.audio) {
    const kbps = p.audio.codec === 'aac' && p.audio.bitrate ? p.audio.bitrate / 1000 : AAC_KBPS;
    aBytes = bytes(kbps, p.duration);
  }
  return Math.round(vBytes + aBytes);
}

export function buildOptions(p) {
  const out = { av: [], video: [], audio: null, lossySource: false };

  if (p.video) {
    const qualities = videoQualities(p);
    const mapQ = (withAudio) =>
      qualities.map((q) => ({
        format: 'mp4',
        quality: String(q.h),
        label: q.label,
        original: Boolean(q.original),
        estBytes: estimateVideo(p, q, withAudio),
      }));
    if (p.audio) out.av = mapQ(true);
    out.video = mapQ(false);
  }

  if (p.audio) {
    const lossless = LOSSLESS.test(p.audio.codec);
    out.lossySource = !lossless;
    const srcKbps = p.audio.bitrate ? p.audio.bitrate / 1000 : null;
    let ceiling = 320;
    if (!lossless) {
      ceiling = srcKbps ? [...MP3_KBPS].reverse().find((b) => b >= srcKbps) ?? 320 : 192;
    }
    const mp3 = MP3_KBPS.filter((b) => b <= ceiling).map((b) => ({
      format: 'mp3',
      quality: String(b),
      label: `${b} kbps`,
      estBytes: p.duration ? bytes(b, p.duration) : null,
    }));
    const channels = Math.min(p.audio.channels, 2);
    const wavBytes = p.duration ? Math.round(p.duration * p.audio.sampleRate * channels * 2) : null;
    const khz = (p.audio.sampleRate / 1000).toFixed(1).replace('.0', '');
    out.audio = {
      mp3,
      wav: [{ format: 'wav', quality: 'pcm16', label: `PCM 16 bits · ${khz} kHz`, estBytes: wavBytes }],
      flac: [
        {
          format: 'flac',
          quality: 'lossless',
          label: `Sin pérdida · ${khz} kHz`,
          estBytes: wavBytes ? Math.round(wavBytes * 0.6) : null,
        },
      ],
    };
  }
  return out;
}

/** Comprueba que la selección del cliente corresponde a una opción realmente ofrecida. */
export function findOption(options, { mode, format, quality }) {
  let pool = [];
  if (mode === 'av') pool = options.av;
  else if (mode === 'video') pool = options.video;
  else if (mode === 'audio') pool = options.audio?.[format] ?? [];
  const opt = pool.find((o) => o.format === format && o.quality === String(quality));
  if (!opt) throw new AppError('invalid_option', 'La opción seleccionada no está disponible para este contenido.');
  return opt;
}

export function buildFfmpegArgs(p, mode, opt, input, output) {
  const args = ['-i', input];
  if (mode === 'audio') {
    args.push('-map', '0:a:0', '-vn', '-ac', String(Math.min(p.audio.channels, 2)));
    if (opt.format === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', `${opt.quality}k`);
    else if (opt.format === 'wav') args.push('-c:a', 'pcm_s16le');
    else args.push('-c:a', 'flac');
  } else {
    args.push('-map', '0:v:0');
    if (opt.original && p.video.codec === 'h264') {
      args.push('-c:v', 'copy');
    } else {
      const h = Number(opt.quality);
      const landscape = p.video.width >= p.video.height;
      if (!opt.original) args.push('-vf', landscape ? `scale=-2:${h}:flags=lanczos` : `scale=${h}:-2:flags=lanczos`);
      else args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    }
    if (mode === 'av') {
      args.push('-map', '0:a:0');
      if (p.audio.codec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', `${AAC_KBPS}k`, '-ac', String(Math.min(p.audio.channels, 2)));
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+faststart');
  }
  args.push(output);
  return args;
}
