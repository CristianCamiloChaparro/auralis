import { h, icon } from './util.js';

const TOAST_ICON = { success: 'check', error: 'alert', info: 'info' };

/** Notificación temporal. type: success | error | info */
export function toast(message, type = 'info', ms = 5000) {
  const root = document.getElementById('toasts');
  const close = () => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  };
  const el = h(
    'div',
    { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICON[type] ?? 'info'),
    h('p', {}, message),
    h('button', { type: 'button', 'aria-label': 'Cerrar notificación', onclick: close }, icon('x')),
  );
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (ms) setTimeout(close, ms);
}

/**
 * Ventana modal accesible (foco atrapado, Esc, clic fuera).
 * actions: [{ label, value, variant }] → la promesa resuelve con `value` (o null al cerrar).
 */
export function modal({ title, body, actions = [{ label: 'Entendido', value: true, variant: 'primary' }] }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const previous = document.activeElement;
    const titleId = `modal-${Date.now()}`;

    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      overlay.classList.add('closing');
      setTimeout(() => {
        overlay.remove();
        previous?.focus?.();
        resolve(value);
      }, 180);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button, a[href]')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const buttons = actions.map((a) =>
      h('button', { type: 'button', class: `btn ${a.variant ?? ''}`, onclick: () => finish(a.value) }, a.label),
    );
    const dialog = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h3', { id: titleId }, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, buttons),
    );
    const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => e.target === overlay && finish(null) }, dialog);
    root.append(overlay);
    document.addEventListener('keydown', onKey);
    buttons.at(-1)?.focus();
  });
}

export const confirmModal = (title, text, confirmLabel, variant = 'primary') =>
  modal({
    title,
    body: h('p', {}, text),
    actions: [
      { label: 'Volver', value: false },
      { label: confirmLabel, value: true, variant },
    ],
  });
