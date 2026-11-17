import { api } from './api.js';
import { initBatch } from './batch.js';
import { analyzeFromHistory, initHome } from './home.js';
import { store } from './store.js';
import { confirmModal, toast } from './ui.js';
import { formatBytes, formatDate, h, icon } from './util.js';

const $ = (id) => document.getElementById(id);
const ROUTES = ['inicio', 'como-funciona', 'formatos', 'faq', 'historial', 'configuracion'];
const TITLES = {
  inicio: 'Auralis — Descarga y convierte video y audio',
  'como-funciona': 'Cómo funciona — Auralis',
  formatos: 'Formatos y calidad — Auralis',
  faq: 'Preguntas frecuentes — Auralis',
  historial: 'Historial — Auralis',
  configuracion: 'Configuración — Auralis',
};

/* ───────── Navegación ───────── */

function route() {
  const name = location.hash.replace(/^#\/?/, '') || 'inicio';
  const current = ROUTES.includes(name) ? name : 'inicio';
  for (const view of document.querySelectorAll('.view')) {
    const active = view.dataset.view === current;
    if (active && view.hidden) {
      view.hidden = false; // al mostrarse se reproduce su animación de entrada
    } else if (!active) {
      view.hidden = true;
    }
  }
  for (const link of document.querySelectorAll('.nav a')) {
    if (link.dataset.route === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = TITLES[current];
  closeNav();
  if (current === 'historial') renderHistory();
  if (current !== 'inicio') window.scrollTo({ top: 0 });
}

function closeNav() {
  $('nav').classList.remove('open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
}

/* ───────── Tema y preferencias ───────── */

function applySettings(s) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  if (s.reduceMotion) root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  $('theme-toggle').setAttribute('aria-label', s.theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');

  for (const [groupId, value] of [['set-theme', s.theme], ['set-mode', s.defaultMode]]) {
    for (const btn of $(groupId).children) btn.setAttribute('aria-checked', String(btn.dataset.value === value));
  }
  $('set-history').setAttribute('aria-checked', String(s.historyEnabled));
  $('set-notify').setAttribute('aria-checked', String(s.notifications));
  $('set-motion').setAttribute('aria-checked', String(s.reduceMotion));
}

function initSettings() {
  $('theme-toggle').addEventListener('click', () =>
    store.set({ theme: store.settings.theme === 'dark' ? 'light' : 'dark' }),
  );
  $('set-theme').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (v) store.set({ theme: v });
  });
  $('set-mode').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.value;
    if (v) store.set({ defaultMode: v });
  });
  $('set-history').addEventListener('click', async () => {
    if (store.settings.historyEnabled && store.history().length) {
      const ok = await confirmModal('¿Desactivar el historial?', 'Se dejarán de registrar operaciones y se borrará el historial guardado en este navegador.', 'Desactivar y borrar');
      if (!ok) return;
      store.clearHistory();
    }
    store.set({ historyEnabled: !store.settings.historyEnabled });
    toast(store.settings.historyEnabled ? 'Historial activado.' : 'Historial desactivado.', 'info', 2500);
  });
  $('set-notify').addEventListener('click', async () => {
    if (store.settings.notifications) return store.set({ notifications: false });
    if (!('Notification' in window)) return toast('Tu navegador no admite notificaciones del sistema.', 'error');
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') return toast('El navegador tiene bloqueadas las notificaciones para este sitio.', 'error');
    store.set({ notifications: true });
    toast('Te avisaremos cuando un archivo esté listo.', 'success', 2500);
  });
  $('set-motion').addEventListener('click', () => store.set({ reduceMotion: !store.settings.reduceMotion }));

  store.onChange(applySettings);
  applySettings(store.settings);
}

/* ───────── Historial ───────── */

const MODE_ICON = { av: 'film', audio: 'music', video: 'video' };

function renderHistory() {
  const body = $('history-body');
  const items = store.history();
  $('history-clear').hidden = !items.length;

  if (!store.settings.historyEnabled && !items.length) {
    body.replaceChildren(
      h('div', { class: 'card empty' }, icon('clock'), h('h3', {}, 'El historial está desactivado'), h('p', {}, 'Actívalo para llevar un registro de tus operaciones. Se guarda solo en este navegador.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { store.set({ historyEnabled: true }); renderHistory(); toast('Historial activado.', 'success', 2500); } }, 'Activar historial')),
    );
    return;
  }
  if (!items.length) {
    body.replaceChildren(
      h('div', { class: 'card empty' }, icon('clock'), h('h3', {}, 'Aún no hay operaciones'), h('p', {}, 'Cuando completes una descarga aparecerá aquí.'), h('a', { class: 'btn primary', href: '#/inicio' }, 'Ir al inicio')),
    );
    return;
  }
  body.replaceChildren(
    h('ul', { class: 'history-list' }, items.map((item) =>
      h('li', { class: 'card history-item' },
        h('span', { class: 'history-ico' }, icon(MODE_ICON[item.mode] ?? 'film')),
        h('div', { class: 'history-main' },
          h('p', { class: 'history-title', title: item.title }, item.title),
          h('p', { class: 'history-meta' }, `${item.modeLabel} · ${item.format.toUpperCase()} · ${item.quality} · ${formatBytes(item.bytes)} · ${item.source} · ${formatDate(item.at)}`),
        ),
        h('div', { class: 'history-actions' },
          item.url ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Analizar de nuevo: ${item.title}`, title: 'Analizar de nuevo', onclick: () => { location.hash = '#/inicio'; analyzeFromHistory(item.url); } }, icon('redo')) : null,
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Quitar del historial: ${item.title}`, title: 'Quitar', onclick: () => { store.removeHistory(item.id); renderHistory(); } }, icon('trash')),
        ),
      ),
    )),
  );
}

/* ───────── Información del servidor ───────── */

async function loadServerInfo() {
  const info = $('server-info');
  try {
    const cfg = await api.config();
    window.__auralisLimits = cfg.limits;
    const { maxDurationMin, maxSourceMB, maxUploadMB, fileTtlMin } = cfg.limits;
    $('faq-limits').textContent = `Duración máxima: ${maxDurationMin} minutos. Tamaño máximo del origen: ${formatBytes(maxSourceMB * 1048576)}. Subidas de hasta ${formatBytes(maxUploadMB * 1048576)}. También limitamos el número de solicitudes y de operaciones simultáneas para evitar abusos.`;
    $('faq-ttl').textContent = `Los archivos generados se eliminan automáticamente a los ${fileTtlMin} minutos.`;
    $('direct-hosts').textContent = cfg.directHosts.length ? `Actualmente: ${cfg.directHosts.join(', ')}.` : '';
    info.replaceChildren(
      h('h3', {}, 'Estado del servidor'),
      h('p', {}, 'Motor de procesamiento: ', h('b', {}, cfg.ready ? 'operativo' : 'no disponible')),
      h('p', {}, 'Descargas de YouTube: ', h('b', {}, cfg.youtubeDownloads ? `activas (yt-dlp ${cfg.ytdlpVersion})` : 'no disponibles (falta yt-dlp)')),
      h('p', {}, 'Límites: ', h('b', {}, `${maxDurationMin} min · ${formatBytes(maxSourceMB * 1048576)} por archivo · subidas de ${formatBytes(maxUploadMB * 1048576)}`)),
    );
    if (!cfg.ready) toast('El servidor no tiene ffmpeg disponible: el procesamiento no funcionará.', 'error', 0);
  } catch {
    info.replaceChildren(h('h3', {}, 'Estado del servidor'), h('p', {}, 'No se pudo conectar con el servidor.'));
    $('faq-limits').textContent = 'No se pudieron consultar los límites del servidor.';
  }
}

/* ───────── Arranque ───────── */

initSettings();
initHome();
initBatch();
loadServerInfo();

$('nav-toggle').addEventListener('click', () => {
  const open = $('nav').classList.toggle('open');
  $('nav-toggle').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.topbar')) closeNav();
});
$('history-clear').addEventListener('click', async () => {
  const ok = await confirmModal('¿Borrar todo el historial?', 'Se eliminarán todas las entradas guardadas en este navegador. Esta acción no se puede deshacer.', 'Borrar todo');
  if (!ok) return;
  store.clearHistory();
  renderHistory();
  toast('Historial borrado.', 'success', 2500);
});

window.addEventListener('hashchange', route);
route();
