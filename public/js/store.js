/** Preferencias e historial: solo en el navegador del usuario. */

const SETTINGS_KEY = 'auralis:settings';
const HISTORY_KEY = 'auralis:history';
const MAX_HISTORY = 50;

const DEFAULTS = {
  theme: 'dark',
  defaultMode: 'av',
  historyEnabled: false,
  notifications: false,
  reduceMotion: false,
};

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento lleno o bloqueado: la app sigue funcionando sin persistir */
  }
}

const listeners = new Set();
let settings = { ...DEFAULTS, ...read(SETTINGS_KEY, {}) };

export const store = {
  get settings() {
    return settings;
  },
  set(patch) {
    settings = { ...settings, ...patch };
    write(SETTINGS_KEY, settings);
    listeners.forEach((fn) => fn(settings));
  },
  onChange(fn) {
    listeners.add(fn);
  },

  history: () => read(HISTORY_KEY, []),
  addHistory(entry) {
    if (!settings.historyEnabled) return;
    write(HISTORY_KEY, [{ ...entry, id: crypto.randomUUID(), at: Date.now() }, ...store.history()].slice(0, MAX_HISTORY));
  },
  removeHistory(id) {
    write(HISTORY_KEY, store.history().filter((e) => e.id !== id));
  },
  clearHistory() {
    write(HISTORY_KEY, []);
  },
};
