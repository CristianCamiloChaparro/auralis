/** Cliente de la API. Todos los errores llegan como Error con `.code`. */

function toError(payload, status) {
  const err = new Error(payload?.error?.message ?? 'No se pudo completar la solicitud.');
  err.code = payload?.error?.code ?? 'network';
  err.status = status;
  return err;
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, options);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw toError({ error: { code: 'network', message: 'No hay conexión con el servidor.' } }, 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw toError(data, res.status);
  return data;
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  config: () => request('/config'),
  analyze: (url, signal) => request('/analyze', { ...json({ url }), signal }),
  createJob: (payload) => request('/jobs', json(payload)),
  getJob: (id) => request(`/jobs/${id}`),
  cancelJob: (id) => request(`/jobs/${id}`, { method: 'DELETE' }),
  fileUrl: (id) => `/api/jobs/${id}/file`,

  /** Subida con progreso real (bytes enviados). Devuelve { promise, abort }. */
  upload(file, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', '/api/upload');
      xhr.responseType = 'json';
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response) : reject(toError(xhr.response, xhr.status));
      xhr.onerror = () =>
        reject(toError({ error: { code: 'network', message: 'La subida se interrumpió.' } }, 0));
      xhr.onabort = () => {
        const e = new Error('cancelado');
        e.name = 'AbortError';
        reject(e);
      };
      xhr.send(file);
    });
    return { promise, abort: () => xhr.abort() };
  },

  /** Sigue un trabajo por SSE; si la conexión falla, continúa por sondeo. */
  watchJob(id, onUpdate) {
    const terminal = (s) => ['done', 'error', 'cancelled'].includes(s);
    let stopped = false;
    let timer = null;
    let es = null;

    const poll = async () => {
      if (stopped) return;
      try {
        const job = await api.getJob(id);
        onUpdate(job);
        if (terminal(job.status)) return;
      } catch (e) {
        if (e.status === 404) {
          onUpdate({ id, status: 'error', error: e.message, percent: 0 });
          return;
        }
      }
      timer = setTimeout(poll, 1000);
    };

    if ('EventSource' in window) {
      es = new EventSource(`/api/jobs/${id}/events`);
      es.onmessage = (ev) => {
        const job = JSON.parse(ev.data);
        onUpdate(job);
        if (terminal(job.status)) es.close();
      };
      es.onerror = () => {
        es.close();
        es = null;
        poll();
      };
    } else {
      poll();
    }
    return () => {
      stopped = true;
      es?.close();
      clearTimeout(timer);
    };
  },
};
