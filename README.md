# Auralis

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/CristianCamiloChaparro/auralis)

Plataforma web para descargar y convertir video y audio de **YouTube**, de otras fuentes compatibles y de **archivos propios**. Interfaz oscura/clara, progreso real del procesamiento y backend con cola de trabajos.

## Usarla en tu computador (Windows, la forma fácil)

1. Instala **Node.js** (versión LTS) desde <https://nodejs.org> y **Python** desde <https://www.python.org/downloads/>. En el instalador de Python marca **"Add Python to PATH"**.
2. En esta página pulsa el botón verde **Code** → **Download ZIP** y descomprímelo.
3. Abre la carpeta y haz doble clic en **`Iniciar Auralis.bat`**.

La primera vez tarda unos minutos porque instala lo necesario. Después se abre sola en el navegador (<http://localhost:3000>). Deja abierta la ventana negra mientras uses la app; ciérrala para apagarla.

Si falta Node.js o Python, el archivo lo avisa y ofrece instalarlo. Cada vez que se abre actualiza yt-dlp, así que si YouTube deja de funcionar, basta con cerrar y volver a abrir `Iniciar Auralis.bat`.

Si Windows muestra "Windows protegió su PC", pulsa **Más información** → **Ejecutar de todas formas**: aparece con cualquier archivo descargado de internet.

## Puesta en marcha

Requisitos: Node.js 20.6 o superior y, para YouTube, Python 3.10 o superior con yt-dlp.

```bash
python -m pip install -U "yt-dlp[default]"
npm install
npm start
```

Al arrancar, la consola indica si encontró ffmpeg y yt-dlp. Sin yt-dlp, los enlaces de YouTube solo muestran información.

Abre <http://localhost:3000>.

`npm install` incluye un ffmpeg empaquetado (dependencia opcional). Si ya tienes `ffmpeg` y `ffprobe` en el PATH puedes instalar con `npm install --omit=optional`.

### Con Docker

```bash
docker compose up --build
```

## Qué fuentes admite

| Fuente | Resultado | Cómo se comprueba |
| --- | --- | --- |
| Archivo propio (subida o arrastrar y soltar) | Descarga y conversión | Se inspecciona el archivo con ffprobe |
| Internet Archive (`archive.org/details/…`) | Descarga y conversión | API pública de metadatos; se rechazan elementos restringidos |
| Wikimedia Commons (`commons.wikimedia.org/wiki/File:…`) | Descarga y conversión | API oficial de MediaWiki |
| PeerTube (`https://instancia/w/…`) | Solo si el autor lo permite | Campo `downloadEnabled` de su API |
| Enlace directo a un archivo | Solo dominios de `DIRECT_HOSTS` | Lista blanca configurable |
| YouTube (videos, Shorts, YouTube Music) | Descarga y conversión | yt-dlp: formatos reales del video |

### Sobre YouTube

La descarga de YouTube usa [yt-dlp](https://github.com/yt-dlp/yt-dlp). Ten en cuenta:

- **Condiciones de uso**: descargar fuera de las funciones de YouTube va contra sus Condiciones del Servicio. Si publicas el servicio en internet, la responsabilidad frente a YouTube y a los titulares de derechos es del operador.
- **Mantenimiento**: YouTube cambia a menudo su sistema. Actualiza yt-dlp con frecuencia (`python -m pip install -U "yt-dlp[default]"`); cuando deja de funcionar, casi siempre se arregla así.
- **Bloqueos**: con mucho tráfico desde una misma IP (habitual en servidores de nube), YouTube puede pedir verificación y rechazar descargas. La app muestra el error en lugar de fallar en silencio.
- **No disponibles**: directos en curso, estrenos pendientes, videos privados, solo para miembros, con restricción de edad o con DRM.
- **Rendimiento**: hasta 1080p YouTube ofrece H.264 y el MP4 se obtiene sin recodificar. 1440p y 2160p solo existen en VP9/AV1 y se recodifican a H.264, lo que exige bastante CPU.

## Opciones de descarga

En el inicio hay dos modos:

- **Un enlace**: analiza un enlace, muestra su información y eliges exactamente la opción.
- **Varios enlaces**: pegas muchos enlaces (uno por línea), eliges una vez tipo, formato y calidad, y se procesan en orden, uno detrás de otro. Cada elemento muestra su progreso real y, al terminar, su botón **Guardar** (o se guarda solo si activas *Guardar cada archivo automáticamente*). Se pueden añadir enlaces mientras la lista avanza, cancelar, reintentar, pausar después del actual y guardar todos al final. Si un enlace no tiene la calidad elegida se usa la más cercana disponible, y si uno falla la lista sigue con el siguiente. Los duplicados (incluido el mismo video de YouTube escrito de otra forma) se descartan.


- **Video con audio**: MP4 (H.264 + AAC). Resoluciones de 144p a 2160p, nunca superiores a la del original. Si el original ya es H.264 y se elige su resolución, se copia sin recomprimir.
- **Solo audio**: MP3 (96–320 kbps, limitado por el bitrate de origen), WAV (PCM 16 bits) y FLAC.
- **Solo video**: MP4 sin pista de audio.

Los tamaños mostrados antes de empezar son estimaciones; el tamaño exacto aparece al terminar.

## Arquitectura

```
server/
  index.js            Arranque, cabeceras de seguridad, estáticos, limpieza periódica
  config.js           Configuración y límites (variables de entorno)
  routes/api.js       API REST + SSE, límites de solicitudes, manejo de errores
  services/
    analyses.js       Análisis de enlaces y subidas; guarda el origen real de cada análisis
    jobs.js           Cola de trabajos, concurrencia, cancelación, caducidad de archivos
  sources/            Un módulo por fuente: { id, name, match(url), resolve(url) }
  lib/
    net.js            Peticiones seguras (anti-SSRF, redirecciones validadas, límite de tamaño)
    ffmpeg.js         ffprobe y ffmpeg con lectura del progreso real
    ytdlp.js          yt-dlp: metadatos, descarga con progreso, cancelación del árbol de procesos
    youtube-plan.js   Qué resoluciones y flujos exactos ofrecer para cada video de YouTube
    options.js        Qué opciones existen para un archivo y cómo generarlas
public/               Frontend sin paso de compilación (módulos ES, CSS con variables)
```

### API

| Método | Ruta | Descripción |
| --- | --- | --- |
| GET | `/api/config` | Límites y estado del servidor |
| POST | `/api/analyze` | `{ url }` → información y opciones disponibles |
| POST | `/api/upload` | Cuerpo binario + cabecera `x-filename` → igual que analyze |
| POST | `/api/jobs` | `{ analysisId, mode, format, quality }` → crea el trabajo |
| GET | `/api/jobs/:id` | Estado del trabajo |
| GET | `/api/jobs/:id/events` | Progreso en tiempo real (SSE) |
| DELETE | `/api/jobs/:id` | Cancela y borra temporales |
| GET | `/api/jobs/:id/file` | Descarga el resultado |

### Progreso

El porcentaje combina dos fases medidas, no simuladas: bytes recibidos del origen (informados por la descarga o por yt-dlp) y tiempo de salida que informa ffmpeg con `-progress` frente a la duración del archivo. El peso de cada fase depende del trabajo real: si el video solo se copia, la descarga es casi todo; si se recodifica, el procesamiento pesa más. Para archivos subidos solo existe la segunda fase.

### Seguridad y protección contra abuso

- Lista de fuentes permitidas; todo lo demás se rechaza.
- Solo `https`, sin credenciales ni puertos no estándar; se bloquean IP privadas y cada redirección se vuelve a validar.
- Límites de duración, tamaño de origen y tamaño de subida, aplicados también durante la transferencia.
- Límite de solicitudes por IP, de trabajos simultáneos por cliente y de tamaño de cola.
- La selección del cliente se valida contra las opciones que el servidor calculó.
- Content-Security-Policy estricta (sin scripts ni estilos en línea); el frontend no usa `innerHTML` con datos externos.
- Archivos temporales por trabajo, borrados al cancelar, al fallar, al caducar (`FILE_TTL_MIN`) y al arrancar o detener el servidor.

## Configuración

Copia `.env.example` como `.env`. Las variables principales:

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PORT` | 3000 | Puerto HTTP |
| `TRUST_PROXY` | — | Pon `1` detrás de un proxy inverso |
| `YOUTUBE_DOWNLOADS` | true | Activa la descarga de YouTube si hay yt-dlp |
| `YTDLP_PATH` | — | Ruta de yt-dlp si no está en el PATH |
| `DIRECT_HOSTS` | `upload.wikimedia.org` | Dominios aceptados para enlaces directos |
| `HTTP_USER_AGENT` | Auralis/1.0 | Identificación ante las fuentes (Wikimedia recomienda incluir contacto) |
| `MAX_DURATION_MIN` | 180 | Duración máxima |
| `MAX_SOURCE_MB` / `MAX_UPLOAD_MB` | 2048 / 1024 | Tamaños máximos |
| `MAX_CONCURRENT_JOBS` | 2 | Procesos ffmpeg simultáneos |
| `FILE_TTL_MIN` | 240 | Minutos que se conserva un resultado en el servidor |

## Despliegue

Cualquier servicio que ejecute contenedores o Node de forma persistente sirve (VPS, Render, Railway, Fly.io). Necesita disco temporal suficiente para el origen y el resultado de los trabajos en curso. No es apto para plataformas serverless con límite de tiempo por petición, porque la cola y los archivos viven en el proceso.

Detrás de un proxy, define `TRUST_PROXY=1` y desactiva el buffering en la ruta de eventos (la respuesta ya envía `X-Accel-Buffering: no` para Nginx).

## Ampliar

- **Nueva fuente**: crea `server/sources/mi-fuente.js` con `match` y `resolve`, y añádela a `server/sources/index.js`.
- **Nuevo formato**: añade la opción en `buildOptions` y sus argumentos en `buildFfmpegArgs` (`server/lib/options.js`).
- **Varias instancias**: sustituye `services/jobs.js` por una cola externa (por ejemplo BullMQ con Redis) y un almacenamiento compartido; la interfaz del módulo se puede conservar.

## Limitaciones conocidas

- La cola y los análisis están en memoria: se pierden al reiniciar el servidor.
- YouTube puede bloquear la IP del servidor o cambiar su sistema; mantén yt-dlp actualizado.
- Las fuentes pueden limitar las descargas (HTTP 429). Se reintenta respetando `Retry-After` y, si persiste, se informa al usuario.
- Las transcodificaciones a 1440p/2160p consumen mucha CPU; ajusta `MAX_CONCURRENT_JOBS` a tu servidor.
