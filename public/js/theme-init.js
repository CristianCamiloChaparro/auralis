// Se ejecuta antes del primer pintado para evitar un parpadeo de tema.
(function () {
  try {
    var s = JSON.parse(localStorage.getItem('auralis:settings') || '{}');
    if (s.theme === 'light' || s.theme === 'dark') document.documentElement.dataset.theme = s.theme;
    if (s.reduceMotion) document.documentElement.dataset.motion = 'reduced';
  } catch (e) {
    /* almacenamiento no disponible: se usa el tema oscuro */
  }
})();
