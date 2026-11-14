FROM node:22-slim

# ffmpeg del sistema y yt-dlp (su solucionador de retos JS usa Node, ya incluido).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    TMP_DIR=/tmp/auralis \
    PORT=3000

COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY server ./server
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
