import { api } from './api.js';
import { store } from './store.js';
import { confirmModal, toast } from './ui.js';
import { formatBytes, h, icon, inspectUrl } from './util.js';

/**
 * Modo "Varios enlaces": una lista que se procesa en orden, de uno en uno.
 * Cada elemento se analiza, se procesa con progreso real y, al terminar,
 * ofrece su botón de guardar (o se guarda solo) antes de pasar al siguiente.
 */

const $ = (id) => document.getElementById(id);
const items = [];
let seq = 0;
let running = false;
let stopAfterCurrent = false;
let els = {};

const DEFAULTS = { mode: 'audio', format: 'mp3', quality: '320', autoSave: true };
const cfg = () => ({ ...DEFAULTS, ...(store.settings.batch ?? {}) });
const setCfg = (patch) => store.set({ batch: { ...cfg(), ...patch } });

const MODES = [
  ['audio', 'Solo audio'],
  ['av', 'Video + audio'],
  ['video', 'Solo video'],
];
const AUDIO_FORMATS = ['mp3', 'wav', 'flac'];
const MP3_QUALITIES = [['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['128', '128 kbps']];
const VIDEO_QUALITIES = [
  ['max', 'Máxima disponible'], ['2160', '2160p 4K'], ['1440', '1440p 2K'], ['1080', '1080p Full HD'],
  ['720', '720p HD'], ['480', '480p'], ['360', '360p'], ['240', '240p'], ['144', '144p'],
];
const RESTRICTIONS = {
  restricted_item: 'Este elemento tiene acceso restringido.',
  no_media: 'No hay video ni audio descargable en este enlace.',
  owner_disabled: 'El autor desactivó la descarga.',
  live: 'Es un directo o un estreno pendiente.',
  ytdlp_missing: 'La descarga de YouTube no está activa en este servidor.',
};
const RETRYABLE = new Set(['too_many_jobs', 'rate_limited', 'server_busy']);
const STORE_KEY = 'auralis:batch-items';
const KEEP = ['id', 'url', 'key', 'source', 'status', 'title', 'thumb', 'choice', 'jobId', 'filename', 'bytes', 'expiresAt', 'saved', 'error', 'saveWhenDone'];

/** Guarda la lista en este navegador para que sobreviva a recargas y cierres. */
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.map((i) => Object.fromEntries(KEEP.map((k) => [k, i[k] ?? null])))));
  } catch {
    /* almacenamiento lleno o bloqueado: la lista sigue funcionando en memoria */
  }
}

function restore() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) ?? [];
  } catch {
    saved = [];
  }
  for (const it of saved) {
    if (!it?.url) continue;
    // Lo que estaba en curso al cerrar la página se vuelve a poner en espera.
    if (ACTIVE.has(it.status)) Object.assign(it, { status: 'pending', jobId: null });
    items.push({ ...it, percent: it.status === 'done' ? 100 : 0 });
    seq = Math.max(seq, Number(it.id) || 0);
  }
}

const isExpired = (item) => item.status === 'done' && item.expiresAt && Date.now() > item.expiresAt;
const timeOf = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const ACTIVE = new Set(['analyzing', 'waiting', 'queued', 'downloading', 'processing']);

/* ───────── Selección de formato ───────── */

/** Elige la opción real más cercana a la preferida sin pasarse (o la más baja si ninguna llega). */
function pickOption(a, c) {
  if (c.mode === 'audio') {
    const list = a.options?.audio?.[c.format];
    if (!list?.length) return null;
    if (c.format !== 'mp3') return list[0];
    return list.find((o) => Number(o.quality) <= Number(c.quality)) ?? list.at(-1);
  }
  const list = a.options?.[c.mode];
  if (!list?.length) return null;
  if (c.quality === 'max') return list[0];
  return list.find((o) => Number(o.quality) <= Number(c.quality)) ?? list.at(-1);
}

/* ───────── Inicialización ───────── */

export function initBatch() {
  els = {
    toggle: $('mode-toggle'),
    single: [$('analyzer'), document.querySelector('.alt-row'), $('stage')],
    panel: $('batch'),
  };

  els.toggle.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (v) setView(v);
  });
  setView(sessionGet('auralis:view') === 'batch' ? 'batch' : 'single');

  restore();
  buildPanel();
  if (items.some((i) => i.status === 'pending')) {
    toast('Se recuperó tu lista de descargas. Pulsa "Iniciar descargas" para continuar.', 'info', 5000);
  }
  // Refresca cada minuto los avisos de "disponible hasta" / "caducado".
  setInterval(() => !running && items.some((i) => i.status === 'done') && renderList(), 60_000);

  window.addEventListener('beforeunload', (e) => {
    if (running || items.some((i) => ACTIVE.has(i.status))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function sessionGet(k) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionSet(k, v) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

function setView(view) {
  for (const b of els.toggle.children) b.setAttribute('aria-checked', String(b.dataset.value === view));
  const batch = view === 'batch';
  els.single.forEach((el) => (el.hidden = batch));
  els.panel.hidden = !batch;
  sessionSet('auralis:view', view);
  if (batch) setTimeout(() => $('batch-input')?.focus({ preventScroll: true }), 50);
}

/* ───────── Panel ───────── */

function buildPanel() {
  const input = h('textarea', {
    id: 'batch-input',
    rows: '1',
    placeholder: 'Pega uno o varios enlaces (uno por línea)…',
    spellcheck: 'false',
    'aria-label': 'Enlaces para añadir a la lista',
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addFromText(input.value);
      }
    },
    oninput: () => autoGrow(input),
  });
  const paste = h('button', {
    class: 'icon-btn ghost', type: 'button', 'aria-label': 'Pegar desde el portapapeles', title: 'Pegar',
    onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text.trim()) return toast('El portapapeles está vacío.', 'info');
        addFromText(text);
      } catch {
        toast('No se pudo leer el portapapeles. Pega con Ctrl+V.', 'info');
        input.focus();
      }
    },
  }, icon('paste'));
  const add = h('button', { class: 'btn primary', type: 'button', onclick: () => addFromText(input.value) }, icon('download'), h('span', {}, 'Añadir'));

  els.input = input;
  els.settings = h('div', { class: 'batch-settings' });
  els.list = h('ol', { class: 'batch-list', 'aria-label': 'Lista de descargas', 'aria-live': 'polite' });
  els.empty = h('div', { class: 'batch-empty' }, icon('music'), h('p', {}, 'Añade enlaces y pulsa '), h('strong', {}, 'Iniciar descargas'), h('p', {}, 'Se procesarán en orden, uno detrás de otro. Puedes seguir añadiendo mientras se descargan.'));
  els.summary = h('p', { class: 'summary' });
  els.actions = h('div', { class: 'batch-actions' });

  els.panel.replaceChildren(
    h('div', { class: 'field batch-field' }, h('span', { class: 'field-ico' }, icon('link')), input, paste, add),
    els.settings,
    h('div', { class: 'card batch-card' }, els.empty, els.list, h('div', { class: 'cta-row batch-footer' }, els.summary, els.actions)),
  );
  renderSettings();
  renderList();
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

function segmented(label, options, value, onPick) {
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    options.map(([v, text]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => onPick(v) }, text),
    ),
  );
}

function renderSettings() {
  const c = cfg();
  const groups = [h('div', { class: 'batch-group' }, h('span', { class: 'group-label' }, 'Tipo'), segmented('Tipo de descarga', MODES, c.mode, (mode) => {
    setCfg({ mode, format: mode === 'audio' ? (AUDIO_FORMATS.includes(c.format) ? c.format : 'mp3') : 'mp4', quality: mode === 'audio' ? '320' : '1080' });
    renderSettings();
  }))];

  if (c.mode === 'audio') {
    groups.push(h('div', { class: 'batch-group' }, h('span', { class: 'group-label' }, 'Formato'), segmented('Formato de audio', AUDIO_FORMATS.map((f) => [f, f.toUpperCase()]), c.format, (format) => {
      setCfg({ format });
      renderSettings();
    })));
    if (c.format === 'mp3') {
      groups.push(qualitySelect(MP3_QUALITIES, c.quality));
    }
  } else {
    groups.push(qualitySelect(VIDEO_QUALITIES, c.quality));
  }

  const auto = h('input', { type: 'checkbox', id: 'batch-autosave', checked: c.autoSave, onchange: (e) => setCfg({ autoSave: e.target.checked }) });
  groups.push(h('label', { class: 'batch-check', for: 'batch-autosave' }, auto, h('span', {}, 'Guardar cada archivo automáticamente al terminar')));

  els.settings.replaceChildren(...groups);
}

function qualitySelect(options, value) {
  const select = h(
    'select',
    { class: 'select', 'aria-label': 'Calidad preferida', onchange: (e) => setCfg({ quality: e.target.value }) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)),
  );
  return h('div', { class: 'batch-group' }, h('span', { class: 'group-label' }, 'Calidad'), select, h('span', { class: 'batch-hint' }, 'o la más cercana disponible'));
}

/* ───────── Añadir enlaces ───────── */

/** Clave para detectar duplicados: un mismo video de YouTube puede escribirse de varias formas. */
function canonical(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)youtube\.com$|^youtu\.be$|youtube-nocookie\.com$/.test(u.hostname)) {
      const id =
        u.hostname === 'youtu.be'
          ? u.pathname.slice(1).split('/')[0]
          : u.searchParams.get('v') ?? /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1];
      if (id) return `yt:${id}`;
    }
    u.hash = '';
    return u.href;
  } catch {
    return href;
  }
}

function addFromText(text) {
  const candidates = [...new Set((text.match(/\S+/g) ?? []).map((s) => s.trim()))];
  if (!candidates.length) {
    toast('Pega al menos un enlace.', 'info');
    return;
  }
  let added = 0;
  let invalid = 0;
  let dup = 0;
  for (const raw of candidates) {
    const r = inspectUrl(raw);
    if (r.state !== 'valid') {
      invalid++;
      continue;
    }
    const key = canonical(r.url);
    if (items.some((i) => i.key === key && i.status !== 'cancelled' && i.status !== 'error')) {
      dup++;
      continue;
    }
    items.push({ id: ++seq, url: r.url, key, source: r.source, status: 'pending', percent: 0 });
    added++;
  }
  els.input.value = '';
  autoGrow(els.input);
  renderList();

  const parts = [];
  if (added) parts.push(`${added} ${added === 1 ? 'enlace añadido' : 'enlaces añadidos'}`);
  if (dup) parts.push(`${dup} ya estaba${dup === 1 ? '' : 'n'} en la lista`);
  if (invalid) parts.push(`${invalid} no ${invalid === 1 ? 'es un enlace válido' : 'son enlaces válidos'}`);
  toast(parts.join(' · '), added ? 'success' : 'error', 3500);
}

/* ───────── Lista ───────── */

function statusText(item) {
  switch (item.status) {
    case 'pending': return 'En espera';
    case 'analyzing': return 'Analizando…';
    case 'waiting': return 'Esperando turno en el servidor…';
    case 'queued': return 'En cola del servidor';
    case 'downloading': return item.percent ? `Descargando · ${item.percent.toFixed(0)} %` : 'Conectando con la fuente…';
    case 'processing': return `Convirtiendo · ${item.percent.toFixed(0)} %`;
    case 'done':
      if (isExpired(item)) return 'Caducado en el servidor · al pulsar Guardar se descarga de nuevo';
      return `Listo · ${formatBytes(item.bytes)}${item.expiresAt ? ` · disponible hasta las ${timeOf(item.expiresAt)}` : ''}`;
    case 'cancelled': return 'Cancelado';
    case 'error': return item.error ?? 'Error';
    default: return '';
  }
}

function renderItem(item) {
  const thumb = h('div', { class: 'bi-thumb' }, icon(cfg().mode === 'audio' ? 'music' : 'film'));
  if (item.thumb) {
    const img = h('img', { src: item.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }

  const actions = [];
  if (item.status === 'done') {
    actions.push(
      h('a', {
        class: 'btn primary small', href: api.fileUrl(item.jobId), download: item.filename,
        onclick: (e) => {
          e.preventDefault();
          saveOrRedo(item);
        },
      }, icon(item.saved ? 'check' : 'download'), h('span', {}, item.saved ? 'Guardado' : 'Guardar')),
    );
  } else if (item.status === 'error' || item.status === 'cancelled') {
    actions.push(h('button', { class: 'icon-btn', type: 'button', title: 'Reintentar', 'aria-label': 'Reintentar', onclick: () => retry(item) }, icon('redo')));
  }
  if (ACTIVE.has(item.status)) {
    actions.push(h('button', { class: 'icon-btn', type: 'button', title: 'Cancelar', 'aria-label': 'Cancelar esta descarga', onclick: () => cancelItem(item) }, icon('x')));
  } else {
    actions.push(h('button', { class: 'icon-btn ghost', type: 'button', title: 'Quitar de la lista', 'aria-label': 'Quitar de la lista', onclick: () => removeItem(item) }, icon('trash')));
  }

  const showBar = ACTIVE.has(item.status) || item.status === 'done';
  const title = item.title ?? item.url;
  const meta = [item.source, item.choice].filter(Boolean).join(' · ');

  const li = h(
    'li',
    { class: `batch-item is-${item.status}`, dataset: { id: String(item.id) } },
    h('span', { class: 'bi-index' }, String(items.indexOf(item) + 1)),
    thumb,
    h(
      'div',
      { class: 'bi-main' },
      h('p', { class: 'bi-title', title }, title),
      h('p', { class: 'bi-status' }, statusText(item), meta ? h('span', { class: 'bi-meta' }, ` · ${meta}`) : null),
      showBar
        ? h('div', { class: 'bar small', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(item.status === 'done' ? 100 : item.percent)), 'aria-label': `Progreso de ${title}` },
          h('div', { class: 'bar-fill', style: `width:${item.status === 'done' ? 100 : item.percent}%` }))
        : null,
    ),
    h('div', { class: 'bi-actions' }, actions),
  );
  return li;
}

function updateItem(item) {
  const old = els.list.querySelector(`[data-id="${item.id}"]`);
  const fresh = renderItem(item);
  if (old) {
    // Conserva el ancho actual de la barra para que la transición sea suave.
    old.replaceWith(fresh);
  }
  renderFooter();
  persist();
}

function renderList() {
  els.list.replaceChildren(...items.map(renderItem));
  els.empty.hidden = items.length > 0;
  els.list.hidden = items.length === 0;
  renderFooter();
  persist();
}

function renderFooter() {
  const done = items.filter((i) => i.status === 'done');
  const pending = items.filter((i) => i.status === 'pending').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const total = items.length;

  els.summary.replaceChildren(
    total
      ? h('span', {}, h('strong', {}, `${done.length} de ${total}`), ' listos', failed ? ` · ${failed} con error` : '', pending ? ` · ${pending} en espera` : '')
      : '',
  );

  const btns = [];
  if (running) {
    btns.push(
      h('button', { class: 'btn subtle', type: 'button', disabled: stopAfterCurrent, onclick: () => { stopAfterCurrent = true; toast('La lista se detendrá al terminar la descarga actual.', 'info', 3000); renderFooter(); } }, stopAfterCurrent ? 'Deteniendo…' : 'Pausar después de esta'),
      h('button', { class: 'btn subtle danger', type: 'button', onclick: cancelAll }, icon('x'), 'Cancelar todo'),
    );
  } else {
    if (done.length) {
      btns.push(h('button', { class: 'btn subtle', type: 'button', onclick: saveAll }, icon('download'), `Guardar todos (${done.length})`));
    }
    if (items.length) {
      btns.push(h('button', { class: 'btn subtle', type: 'button', onclick: copyLinks }, icon('link'), 'Copiar enlaces'));
    }
    if (items.some((i) => !ACTIVE.has(i.status) && i.status !== 'pending')) {
      btns.push(h('button', { class: 'btn subtle', type: 'button', onclick: clearFinished }, 'Limpiar terminados'));
    }
    btns.push(h('button', { class: 'btn primary', type: 'button', disabled: !pending, onclick: runQueue }, icon('download'), h('span', {}, pending ? `Iniciar descargas (${pending})` : 'Iniciar descargas')));
  }
  els.actions.replaceChildren(...btns);
}

/* ───────── Acciones ───────── */

function retry(item) {
  Object.assign(item, { status: 'pending', percent: 0, error: null, jobId: null, saved: false });
  // Al final de la cola para no saltarse a los que esperan.
  items.splice(items.indexOf(item), 1);
  items.push(item);
  renderList();
  if (running) return;
  runQueue();
}

function removeItem(item) {
  items.splice(items.indexOf(item), 1);
  renderList();
}

async function cancelItem(item) {
  item.cancelRequested = true;
  item.abort?.abort();
  if (item.jobId) await api.cancelJob(item.jobId).catch(() => {});
  else if (item.status !== 'done') {
    item.status = 'cancelled';
    updateItem(item);
  }
}

async function cancelAll() {
  const ok = await confirmModal('¿Cancelar toda la lista?', 'Se detendrá la descarga actual y no se procesarán las que están en espera. Las ya terminadas se conservan.', 'Cancelar todo');
  if (!ok) return;
  for (const i of items) if (i.status === 'pending') i.status = 'cancelled';
  const current = items.find((i) => ACTIVE.has(i.status));
  if (current) await cancelItem(current);
  renderList();
}

async function copyLinks() {
  const text = items.map((i) => i.url).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(`${items.length} ${items.length === 1 ? 'enlace copiado' : 'enlaces copiados'} al portapapeles.`, 'success', 3000);
  } catch {
    toast('No se pudo copiar al portapapeles.', 'error');
  }
}

function clearFinished() {
  for (let k = items.length - 1; k >= 0; k--) {
    if (['done', 'error', 'cancelled'].includes(items[k].status)) items.splice(k, 1);
  }
  renderList();
}

function triggerSave(item) {
  const a = h('a', { href: api.fileUrl(item.jobId), download: item.filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  item.saved = true;
}

async function saveAll() {
  const done = items.filter((i) => i.status === 'done');
  let redo = 0;
  for (const item of done) {
    if (isExpired(item) || !(await fileExists(item))) {
      requeue(item);
      redo++;
      continue;
    }
    triggerSave(item);
    updateItem(item);
    // Pequeña pausa: los navegadores ignoran varias descargas simultáneas.
    await new Promise((r) => setTimeout(r, 700));
  }
  if (redo) {
    toast(`${redo} ${redo === 1 ? 'archivo había caducado y se descargará' : 'archivos habían caducado y se descargarán'} de nuevo; se guardarán solos al terminar.`, 'info', 6000);
    runQueue();
  }
}

async function fileExists(item) {
  if (!item.jobId) return false;
  try {
    const res = await fetch(api.fileUrl(item.jobId), { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Vuelve a poner un elemento en espera y lo guarda automáticamente al terminar. */
function requeue(item) {
  Object.assign(item, { status: 'pending', percent: 0, error: null, jobId: null, saved: false, saveWhenDone: true });
  updateItem(item);
}

/** Guarda el archivo si sigue en el servidor; si caducó, lo vuelve a procesar. */
async function saveOrRedo(item) {
  if (!isExpired(item) && (await fileExists(item))) {
    triggerSave(item);
    updateItem(item);
    return;
  }
  requeue(item);
  toast('Ese archivo había caducado en el servidor. Se descarga de nuevo y se guardará solo al terminar.', 'info', 5000);
  runQueue();
}

/* ───────── Procesamiento en orden ───────── */

async function withRetry(item, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= 30 || item.cancelRequested) throw err;
      item.status = 'waiting';
      updateItem(item);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function fail(item, message) {
  item.status = item.cancelRequested ? 'cancelled' : 'error';
  item.error = message;
  updateItem(item);
}

async function processItem(item) {
  Object.assign(item, { status: 'analyzing', percent: 0, error: null, cancelRequested: false });
  item.abort = new AbortController();
  updateItem(item);

  let a;
  try {
    a = await withRetry(item, () => api.analyze(item.url, item.abort.signal));
  } catch (err) {
    return fail(item, err.name === 'AbortError' ? 'Cancelado' : err.message);
  }
  Object.assign(item, { title: a.title, thumb: a.thumbnail, source: a.source?.name ?? item.source });
  if (item.cancelRequested) return fail(item, 'Cancelado');
  if (!a.downloadable) return fail(item, RESTRICTIONS[a.restriction] ?? 'Este contenido no se puede descargar.');

  const c = cfg();
  const opt = pickOption(a, c);
  if (!opt) return fail(item, c.mode === 'audio' ? 'Este enlace no tiene audio.' : 'Este enlace no tiene video.');
  item.choice = `${opt.format.toUpperCase()} · ${opt.label}`;
  updateItem(item);

  let job;
  try {
    job = await withRetry(item, () => api.createJob({ analysisId: a.id, mode: c.mode, format: opt.format, quality: opt.quality }));
  } catch (err) {
    return fail(item, err.message);
  }
  item.jobId = job.id;
  item.status = 'queued';
  updateItem(item);

  await new Promise((resolve) => {
    api.watchJob(job.id, (j) => {
      if (j.status === 'queued') item.status = 'queued';
      else if (j.status === 'downloading' || j.status === 'processing') {
        item.status = j.status;
        item.percent = j.percent ?? 0;
      } else if (j.status === 'done') {
        Object.assign(item, { status: 'done', percent: 100, filename: j.filename, bytes: j.outputBytes, expiresAt: j.expiresAt });
        onDone(item, j, a);
      } else if (j.status === 'cancelled') {
        item.status = 'cancelled';
        item.jobId = null;
      } else if (j.status === 'error') {
        item.status = 'error';
        item.error = j.error ?? 'El procesamiento falló.';
        item.jobId = null;
      }
      updateItem(item);
      if (['done', 'error', 'cancelled'].includes(j.status)) resolve();
    });
  });
}

function onDone(item, j, a) {
  if (cfg().autoSave || item.saveWhenDone) triggerSave(item);
  item.saveWhenDone = false;
  toast(`Listo: ${item.title}`, 'success', 2500);
  store.addHistory({
    title: a.title,
    source: a.source.name,
    url: item.url,
    mode: j.mode,
    modeLabel: j.modeLabel,
    format: j.format,
    quality: j.qualityLabel,
    bytes: j.outputBytes,
  });
}

async function runQueue() {
  if (running) return;
  running = true;
  stopAfterCurrent = false;
  renderFooter();
  try {
    for (;;) {
      if (stopAfterCurrent) break;
      const next = items.find((i) => i.status === 'pending');
      if (!next) break;
      await processItem(next);
    }
  } finally {
    running = false;
    const wasStopped = stopAfterCurrent;
    stopAfterCurrent = false;
    renderList();
    finished(wasStopped);
  }
}

function finished(paused) {
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  if (paused && pending) {
    toast(`Lista en pausa. Quedan ${pending} en espera.`, 'info', 4000);
    return;
  }
  const msg = `Lista terminada: ${done} ${done === 1 ? 'listo' : 'listos'}${failed ? ` y ${failed} con error` : ''}.`;
  toast(msg, failed ? 'info' : 'success', 6000);
  if (store.settings.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Auralis: lista terminada', { body: msg, icon: '/img/logo.svg' });
  }
}
