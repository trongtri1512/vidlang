FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp + EJS challenge solver via pip
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp yt-dlp-ejs
ENV PATH="/opt/venv/bin:$PATH"

# Symlink Node.js so yt-dlp can use it as JS runtime for signature decryption
RUN ln -sf /usr/local/bin/node /usr/bin/node

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p jobs output

EXPOSE 3000

CMD ["node", "server.js"]
