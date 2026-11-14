import { api } from './api.js';
import { store } from './store.js';
import { confirmModal, toast } from './ui.js';
import { formatBytes, formatDuration, h, icon, inspectUrl } from './util.js';

/** Pantalla principal: analizar → elegir → procesar → guardar. */

const $ = (id) => document.getElementById(id);
const els = {};
const state = {
  analysis: null,
  mode: null,
  audioFormat: 'mp3',
  choice: {}, // por modo: opción elegida
  stopWatch: null,
  job: null,
  pending: null, // análisis o subida en curso { abort }
};

const MODES = {
  av: { label: 'Video con audio', short: 'Video + audio', icon: 'film' },
  audio: { label: 'Solo audio', short: 'Audio', icon: 'music' },
  video: { label: 'Solo video', short: 'Video', icon: 'video' },
};
const RESTRICTIONS = {
  restricted_item: ['Este elemento tiene acceso restringido', 'Internet Archive no ofrece este elemento para descarga pública.'],
  no_media: ['No hay video ni audio descargable', 'La fuente no ofrece un archivo de video o audio en este enlace.'],
  owner_disabled: ['El autor desactivó la descarga', 'En PeerTube cada autor decide si su video se puede descargar, y en este caso no lo permite.'],
  live: ['Es un directo o un estreno pendiente', 'Las emisiones en directo no se pueden descargar. Inténtalo cuando hayan terminado.'],
};

export function initHome() {
  Object.assign(els, {
    form: $('analyzer'), field: $('field'), input: $('url'), hint: $('url-hint'),
    clear: $('clear-btn'), paste: $('paste-btn'), analyze: $('analyze-btn'),
    upload: $('upload-btn'), file: $('file-input'), stage: $('stage'),
  });

  els.input.addEventListener('input', () => validate(false));
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    analyze();
  });
  els.clear.addEventListener('click', () => {
    els.input.value = '';
    validate(false);
    els.input.focus();
  });
  els.paste.addEventListener('click', pasteFromClipboard);
  els.upload.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', () => {
    if (els.file.files[0]) uploadFile(els.file.files[0]);
    els.file.value = '';
  });

  // Arrastrar y soltar un archivo propio en cualquier parte de la página.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) {
      location.hash = '#/inicio';
      uploadFile(file);
    }
  });
}

/** Permite relanzar un enlace desde el historial. */
export function analyzeFromHistory(url) {
  els.input.value = url;
  analyze();
}

/* ───────── Validación y entrada ───────── */

function setHint(text = '', kind = '') {
  els.hint.className = `hint ${kind}`;
  els.hint.textContent = text;
}

function validate(strict) {
  const result = inspectUrl(els.input.value);
  els.clear.hidden = result.state === 'empty';
  els.field.classList.toggle('invalid', result.state === 'invalid' && (strict || els.input.value.length > 8));
  els.field.classList.toggle('valid', result.state === 'valid');
  if (result.state === 'empty') setHint(strict ? 'Pega primero un enlace.' : '', strict ? 'err' : '');
  else if (result.state === 'invalid') {
    if (strict || els.input.value.length > 8) setHint(result.message, 'err');
    else setHint();
  } else if (result.source) setHint(`Enlace de ${result.source} detectado.`, 'ok');
  else setHint('Enlace válido. Se comprobará si la fuente está permitida.');
  return result;
}

async function pasteFromClipboard() {
  if (!navigator.clipboard?.readText) {
    toast('Tu navegador no permite leer el portapapeles. Pega con Ctrl+V.', 'info');
    els.input.focus();
    return;
  }
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return toast('El portapapeles está vacío.', 'info');
    els.input.value = text;
    const result = validate(true);
    if (result.state === 'valid') analyze();
  } catch {
    toast('No se concedió permiso para leer el portapapeles. Pega con Ctrl+V.', 'info');
    els.input.focus();
  }
}

function setBusy(busy) {
  els.analyze.disabled = busy;
  els.upload.disabled = busy;
  els.analyze.replaceChildren(
    busy ? h('span', { class: 'spinner' }) : icon('scan'),
    h('span', {}, busy ? 'Analizando…' : 'Analizar'),
  );
}

/* ───────── Analizar ───────── */

async function leaveCurrentJob() {
  if (!state.job || !['queued', 'downloading', 'processing'].includes(state.job.status)) return true;
  const ok = await confirmModal(
    'Hay una operación en curso',
    'Si continúas, se cancelará el procesamiento actual y se eliminarán sus archivos.',
    'Cancelar operación',
    'primary',
  );
  if (ok) await api.cancelJob(state.job.id).catch(() => {});
  return ok;
}

function resetStage() {
  state.stopWatch?.();
  state.pending?.abort();
  Object.assign(state, { stopWatch: null, job: null, analysis: null, pending: null, choice: {} });
  els.stage.replaceChildren();
}

async function analyze() {
  const result = validate(true);
  if (result.state !== 'valid') return els.input.focus();
  if (!(await leaveCurrentJob())) return;
  resetStage();

  const controller = new AbortController();
  state.pending = controller;
  setBusy(true);
  els.stage.replaceChildren(skeleton());
  try {
    const analysis = await api.analyze(result.url, controller.signal);
    state.pending = null;
    showAnalysis(analysis, result.url);
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.pending = null;
    els.stage.replaceChildren(errorCard('No se pudo analizar el enlace', err.message));
    setHint(err.message, 'err');
    toast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function uploadFile(file) {
  if (!/^(video|audio)\//.test(file.type) && !/\.(mkv|flac|ogv|opus|mp4|mov|webm|mp3|wav|m4a|ogg|avi)$/i.test(file.name)) {
    return toast('Ese archivo no parece ser de video ni de audio.', 'error');
  }
  const max = window.__auralisLimits?.maxUploadMB;
  if (max && file.size > max * 1048576) {
    return toast(`El archivo supera el máximo de subida (${max} MB).`, 'error');
  }
  if (!(await leaveCurrentJob())) return;
  resetStage();

  const card = progressCard({
    status: 'Subiendo tu archivo',
    sub: file.name,
    onCancel: () => state.pending?.abort(),
  });
  els.stage.replaceChildren(card.el);
  card.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setBusy(true);

  const up = api.upload(file, (sent, total) => {
    const pct = (sent / total) * 100;
    card.set(pct, [['Enviado', `${formatBytes(sent)} de ${formatBytes(total)}`]]);
    if (sent === total) card.status('Analizando el archivo…');
  });
  state.pending = up;
  try {
    const analysis = await up.promise;
    state.pending = null;
    showAnalysis(analysis, null);
  } catch (err) {
    state.pending = null;
    if (err.name === 'AbortError') {
      els.stage.replaceChildren();
      toast('Subida cancelada.', 'info');
    } else {
      els.stage.replaceChildren(errorCard('No se pudo procesar el archivo', err.message));
      toast(err.message, 'error');
    }
  } finally {
    setBusy(false);
  }
}

/* ───────── Tarjetas ───────── */

function skeleton() {
  return h(
    'div',
    { class: 'card info skeleton', 'aria-busy': 'true', 'aria-label': 'Analizando el enlace' },
    h('div', { class: 'sk sk-thumb' }),
    h('div', {}, h('div', { class: 'sk sk-line', style: null }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line' })),
  );
}

function errorCard(title, message) {
  return h(
    'div',
    { class: 'card job', role: 'alert' },
    h('div', { class: 'result-ico err' }, icon('alert')),
    h('h3', {}, title),
    h('p', { class: 'job-sub' }, message),
    h(
      'div',
      { class: 'job-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => { resetStage(); els.input.focus(); } }, 'Probar con otro enlace'),
      h('button', { class: 'btn subtle', type: 'button', onclick: () => els.file.click() }, icon('upload'), 'Subir un archivo'),
    ),
  );
}

function infoCard(a) {
  const thumb = h('div', { class: 'thumb' }, icon(a.hasVideo || !a.options ? 'film' : 'music'));
  if (a.thumbnail) {
    const img = h('img', { src: a.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    thumb.append(img);
  }
  const dur = formatDuration(a.duration);
  if (dur) thumb.append(h('span', { class: 'dur' }, dur));

  const meta = [
    a.author && ['user', a.author],
    dur && ['clock', dur],
    a.resolution && ['screen', a.fps ? `${a.resolution} · ${a.fps} fps` : a.resolution],
    a.sourceBytes && ['download', formatBytes(a.sourceBytes)],
    a.license && ['license', a.license.replace(/^https?:\/\/(www\.)?/, '')],
  ].filter(Boolean);

  const formats = [];
  if (a.options?.av.length || a.options?.video.length) formats.push('MP4');
  if (a.options?.audio) formats.push('MP3', 'WAV', 'FLAC');

  return h(
    'article',
    { class: 'card info' },
    thumb,
    h(
      'div',
      { class: 'info-body' },
      h('span', { class: 'badge' }, a.instance ? `${a.source.name} · ${a.instance}` : a.source.name),
      h('h2', { title: a.title }, a.title),
      h('ul', { class: 'meta' }, meta.map(([ic, text]) => h('li', {}, icon(ic), h('span', {}, text)))),
      formats.length ? h('div', { class: 'fmt-row', 'aria-label': 'Formatos disponibles' }, formats.map((f) => h('span', { class: 'fmt-pill' }, f))) : null,
    ),
  );
}

function noticeCard(a) {
  const alt = (title, text, action) => h('div', { class: 'alt' }, h('strong', {}, title), h('span', {}, text), action);
  if (a.restriction === 'ytdlp_missing') {
    return h(
      'div',
      { class: 'card notice', role: 'note' },
      h(
        'div',
        { class: 'notice-head' },
        icon('alert'),
        h(
          'div',
          {},
          h('h3', {}, 'La descarga de YouTube no está activa en este servidor'),
          h('p', {}, 'Falta instalar yt-dlp en el servidor (o está desactivado con YOUTUBE_DOWNLOADS=false). Mientras tanto puedes:'),
        ),
      ),
      h(
        'div',
        { class: 'alts' },
        alt('¿Tienes el archivo?', 'Súbelo y conviértelo a cualquier formato.', h('button', { class: 'btn subtle', type: 'button', onclick: () => els.file.click() }, icon('upload'), 'Subir el archivo')),
        alt('¿Está en otra fuente?', 'Pega su enlace de Internet Archive, Wikimedia Commons o PeerTube.', h('a', { class: 'btn subtle', href: a.pageUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir en YouTube')),
      ),
    );
  }
  const [title, text] = RESTRICTIONS[a.restriction] ?? ['Este contenido no se puede descargar', 'La fuente no permite la descarga de este contenido.'];
  return h(
    'div',
    { class: 'card notice', role: 'note' },
    h('div', { class: 'notice-head' }, icon('alert'), h('div', {}, h('h3', {}, title), h('p', {}, text))),
  );
}

function showAnalysis(a, url) {
  state.analysis = { ...a, url };
  const nodes = [infoCard(a)];
  if (!a.downloadable) nodes.push(noticeCard(a));
  else nodes.push(optionsPanel(a));
  els.stage.replaceChildren(...nodes);
  nodes[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(a.downloadable ? 'Contenido analizado. Elige formato y calidad.' : 'Información obtenida. Esta fuente no permite la descarga.', a.downloadable ? 'success' : 'info', 3500);
}

/* ───────── Opciones de descarga ───────── */

function optionsPanel(a) {
  const available = ['av', 'audio', 'video'].filter((m) => (m === 'audio' ? a.options.audio : a.options[m].length));
  state.mode = available.includes(store.settings.defaultMode) ? store.settings.defaultMode : available[0];
  state.audioFormat = 'mp3';
  state.choice = {
    av: a.options.av[0],
    video: a.options.video[0],
    audio: a.options.audio?.mp3[0],
  };

  const panel = h('section', { class: 'card panel', 'aria-label': 'Opciones de descarga' });
  const body = h('div', { class: 'tabpanel', role: 'tabpanel', id: 'opt-panel' });
  const summary = h('p', { class: 'summary' });
  const start = h('button', { class: 'btn primary big', type: 'button', onclick: startJob }, icon('download'), h('span', {}, 'Iniciar descarga'));

  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Tipo de descarga' },
    available.map((m) =>
      h(
        'button',
        {
          class: 'tab', type: 'button', role: 'tab', id: `tab-${m}`, 'aria-controls': 'opt-panel',
          dataset: { mode: m },
          onclick: () => { state.mode = m; render(); },
          onkeydown: (e) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const i = available.indexOf(m) + (e.key === 'ArrowRight' ? 1 : -1);
            const next = available[(i + available.length) % available.length];
            state.mode = next;
            render();
            tabs.querySelector(`[data-mode="${next}"]`).focus();
          },
        },
        icon(MODES[m].icon),
        h('span', {}, MODES[m].label),
      ),
    ),
  );

  const optCard = (opt, group, onPick) => {
    const checked = state.choice[state.mode] === opt;
    const input = h('input', { type: 'radio', name: group, checked, 'aria-label': `${opt.label}, ${opt.estBytes ? `aproximadamente ${formatBytes(opt.estBytes)}` : 'tamaño no disponible'}` });
    input.addEventListener('change', () => { onPick(opt); updateSummary(); });
    return h(
      'label',
      { class: 'opt' },
      input,
      h('span', { class: 'opt-card' }, h('span', { class: 'opt-title' }, opt.label), h('span', { class: 'opt-sub' }, opt.estBytes ? `≈ ${formatBytes(opt.estBytes)}` : 'Tamaño no disponible')),
      opt.original ? h('span', { class: 'opt-flag' }, 'ORIGINAL') : null,
    );
  };

  function updateSummary() {
    const opt = state.choice[state.mode];
    summary.replaceChildren(
      h('strong', {}, MODES[state.mode].label),
      ` · ${opt.format.toUpperCase()} · ${opt.label}`,
      opt.estBytes ? ` · ≈ ${formatBytes(opt.estBytes)}` : '',
    );
  }

  function render() {
    for (const t of tabs.children) {
      const on = t.dataset.mode === state.mode;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `tab-${state.mode}`);
    const content = [];
    if (state.mode === 'audio') {
      const formats = ['mp3', 'wav', 'flac'];
      content.push(
        h('p', { class: 'group-label' }, 'Formato'),
        h('div', { class: 'fmt-switch', role: 'group', 'aria-label': 'Formato de audio' }, formats.map((f) =>
          h('button', {
            type: 'button', 'aria-pressed': String(state.audioFormat === f),
            onclick: () => { state.audioFormat = f; state.choice.audio = a.options.audio[f][0]; render(); },
          }, f.toUpperCase()),
        )),
        h('p', { class: 'group-label' }, 'Calidad'),
        h('div', { class: 'opts' }, a.options.audio[state.audioFormat].map((o) => optCard(o, 'q-audio', (opt) => (state.choice.audio = opt)))),
      );
      if (state.audioFormat !== 'mp3' && a.options.lossySource) {
        content.push(h('p', { class: 'note' }, icon('info'), 'El audio original ya está comprimido: este formato conserva la calidad actual, pero no la mejora.'));
      }
    } else {
      content.push(
        h('p', { class: 'group-label' }, state.mode === 'av' ? 'Resolución · MP4 con audio' : 'Resolución · MP4 sin audio'),
        h('div', { class: 'opts' }, a.options[state.mode].map((o) => optCard(o, `q-${state.mode}`, (opt) => (state.choice[state.mode] = opt)))),
      );
    }
    body.replaceChildren(...content);
    // Reinicia la animación de entrada del panel.
    body.style.animation = 'none';
    void body.offsetWidth;
    body.style.animation = '';
    updateSummary();
  }

  panel.append(tabs, body, h('div', { class: 'cta-row' }, summary, start));
  render();
  return panel;
}

/* ───────── Trabajo ───────── */

function progressCard({ status, sub, onCancel }) {
  const statusEl = h('p', { class: 'job-status' }, status);
  const subEl = h('p', { class: 'job-sub' }, sub ?? '');
  const num = document.createTextNode('0');
  const fill = h('div', { class: 'bar-fill' });
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Progreso' }, fill);
  const phases = h('div', { class: 'phases' });
  const stats = h('div', { class: 'stats' });
  const cancel = h('button', { class: 'btn subtle danger', type: 'button', onclick: onCancel }, icon('x'), 'Cancelar');
  const el = h(
    'section',
    { class: 'card job', 'aria-label': 'Progreso de la operación' },
    h('div', { class: 'viz', 'aria-hidden': 'true' }, Array.from({ length: 7 }, () => h('i'))),
    statusEl, subEl,
    h('div', { class: 'pct' }, num, h('small', {}, '%')),
    bar, phases, stats,
    h('div', { class: 'job-actions' }, cancel),
  );
  return {
    el,
    cancelBtn: cancel,
    status: (t) => (statusEl.textContent = t),
    sub: (t) => (subEl.textContent = t),
    set(pct, statList = []) {
      const v = Math.max(0, Math.min(100, pct));
      num.nodeValue = v.toFixed(v > 0 && v < 100 ? 1 : 0);
      fill.style.width = `${v}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(v)));
      stats.replaceChildren(...statList.map(([k, val]) => h('div', { class: 'stat' }, h('b', {}, val), k)));
    },
    phases(list) {
      phases.replaceChildren(
        ...list.map(([label, st]) => h('span', { class: `phase ${st}` }, st === 'done' ? icon('check') : null, label)),
      );
    },
  };
}

async function startJob(e) {
  const btn = e.currentTarget;
  const a = state.analysis;
  const opt = state.choice[state.mode];
  const mode = state.mode;
  btn.disabled = true;
  let job;
  try {
    job = await api.createJob({ analysisId: a.id, mode, format: opt.format, quality: opt.quality });
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'error');
    if (err.code === 'analysis_expired') resetStage();
    return;
  }
  state.job = job;
  const remote = a.source.id !== 'upload';

  const card = progressCard({
    status: 'Preparando…',
    sub: `${MODES[mode].label} · ${opt.format.toUpperCase()} · ${opt.label}`,
    onCancel: async () => {
      const ok = await confirmModal('¿Cancelar la operación?', 'Se detendrá el procesamiento y se eliminarán los archivos temporales.', 'Sí, cancelar');
      if (!ok || !state.job || state.job.id !== job.id) return;
      card.cancelBtn.disabled = true;
      api.cancelJob(job.id).catch((err) => toast(err.message, 'error'));
    },
  });
  const panel = els.stage.querySelector('.panel');
  panel.replaceWith(card.el);
  card.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  state.stopWatch = api.watchJob(job.id, (j) => {
    if (state.job?.id !== j.id) return;
    state.job = j;
    if (j.status === 'queued') {
      card.status('En cola');
      card.sub(j.queuePosition > 0 ? `Posición ${j.queuePosition} en la cola del servidor` : 'A punto de empezar');
      card.set(0);
      card.phases(remote ? [['En cola', 'active'], ['Obtener origen', ''], ['Procesar', '']] : [['En cola', 'active'], ['Procesar', '']]);
    } else if (j.status === 'downloading') {
      card.status(j.downloadedBytes ? 'Obteniendo el archivo de origen' : 'Conectando con la fuente…');
      card.set(j.percent, [
        ['Recibido', j.sourceBytes ? `${formatBytes(j.downloadedBytes)} de ${formatBytes(j.sourceBytes)}` : formatBytes(j.downloadedBytes)],
        ['Fase', `${j.stagePercent.toFixed(0)} %`],
      ]);
      card.phases([['Obtener origen', 'active'], ['Procesar', '']]);
    } else if (j.status === 'processing') {
      card.status(mode === 'audio' ? 'Extrayendo y codificando el audio' : 'Procesando el video');
      card.set(j.percent, [
        ['Archivo generado', formatBytes(j.outputBytes)],
        ['Fase', `${j.stagePercent.toFixed(0)} %`],
        j.speed ? ['Velocidad', `${j.speed.toFixed(1)}×`] : null,
      ].filter(Boolean));
      card.phases(remote ? [['Obtener origen', 'done'], ['Procesar', 'active']] : [['Procesar', 'active']]);
    } else if (j.status === 'done') {
      finish(j, a);
    } else if (j.status === 'cancelled') {
      state.job = null;
      card.el.replaceWith(optionsPanel(a));
      toast('Operación cancelada. Los archivos temporales se eliminaron.', 'info');
    } else if (j.status === 'error') {
      state.job = null;
      card.el.replaceWith(
        h(
          'section',
          { class: 'card job', role: 'alert' },
          h('div', { class: 'result-ico err' }, icon('alert')),
          h('h3', {}, 'No se pudo completar'),
          h('p', { class: 'job-sub' }, j.error ?? 'Ocurrió un error durante el procesamiento.'),
          h('div', { class: 'job-actions' }, h('button', { class: 'btn', type: 'button', onclick: (ev) => ev.currentTarget.closest('.job').replaceWith(optionsPanel(a)) }, icon('redo'), 'Elegir otra opción')),
        ),
      );
      toast(j.error ?? 'El procesamiento falló.', 'error');
    }
  });
}

function finish(j, a) {
  const expires = j.expiresAt ? new Date(j.expiresAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : null;
  const done = h(
    'section',
    { class: 'card job', 'aria-label': 'Archivo listo' },
    h('div', { class: 'result-ico ok' }, icon('check')),
    h('h3', {}, '¡Tu archivo está listo!'),
    h('p', { class: 'job-sub' }, j.filename),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, j.modeLabel), 'Tipo'),
      h('div', { class: 'stat' }, h('b', {}, j.format.toUpperCase()), 'Formato'),
      h('div', { class: 'stat' }, h('b', {}, j.qualityLabel), 'Calidad'),
      h('div', { class: 'stat' }, h('b', {}, formatBytes(j.outputBytes)), 'Tamaño final'),
    ),
    h(
      'div',
      { class: 'job-actions' },
      h('a', { class: 'btn primary big', href: api.fileUrl(j.id), download: j.filename }, icon('download'), h('span', {}, 'Guardar archivo')),
      h('button', { class: 'btn big', type: 'button', onclick: (ev) => { state.job = null; ev.currentTarget.closest('.job').replaceWith(optionsPanel(a)); } }, 'Otro formato'),
      h('button', {
        class: 'btn big', type: 'button',
        onclick: () => { resetStage(); els.input.value = ''; validate(false); window.scrollTo({ top: 0, behavior: 'smooth' }); els.input.focus({ preventScroll: true }); },
      }, 'Nueva descarga'),
    ),
    expires ? h('p', { class: 'note', style: null }, icon('clock'), `Disponible en el servidor hasta las ${expires}. Después se elimina automáticamente.`) : null,
  );
  els.stage.querySelector('.job').replaceWith(done);
  done.querySelector('a').focus({ preventScroll: true });

  toast(`Listo: ${j.format.toUpperCase()} · ${j.qualityLabel} (${formatBytes(j.outputBytes)})`, 'success', 7000);
  if (store.settings.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('Auralis: tu archivo está listo', { body: j.filename, icon: '/img/logo.svg' });
  }
  store.addHistory({
    title: a.title,
    source: a.source.name,
    url: state.analysis?.url ?? null,
    mode: j.mode,
    modeLabel: j.modeLabel,
    format: j.format,
    quality: j.qualityLabel,
    bytes: j.outputBytes,
  });
}
