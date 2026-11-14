const SVG_NS = 'http://www.w3.org/2000/svg';

/** Crea elementos DOM sin innerHTML: los datos externos siempre entran como texto. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString('es', { maximumFractionDigits: n >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
}

const KNOWN = [
  [/(^|\.)youtube\.com$|^youtu\.be$|youtube-nocookie\.com$/, 'YouTube'],
  [/(^|\.)archive\.org$/, 'Internet Archive'],
  [/^commons\.wikimedia\.org$|^upload\.wikimedia\.org$/, 'Wikimedia Commons'],
];

/** Validación en el cliente (el servidor siempre vuelve a validar). */
export function inspectUrl(raw) {
  const value = raw.trim();
  if (!value) return { state: 'empty' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { state: 'invalid', message: 'Eso no parece un enlace. Debe empezar por https://' };
  }
  if (url.protocol !== 'https:') {
    return { state: 'invalid', message: 'Solo se aceptan enlaces https://' };
  }
  if (!url.hostname.includes('.')) {
    return { state: 'invalid', message: 'El dominio del enlace no es válido.' };
  }
  const known = KNOWN.find(([re]) => re.test(url.hostname));
  return { state: 'valid', source: known?.[1] ?? null, url: url.href };
}
