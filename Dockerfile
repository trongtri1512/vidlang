FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp (nightly for best YouTube compatibility)
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Symlink Node.js so yt-dlp can use it as JS runtime for signature decryption
RUN ln -sf /usr/local/bin/node /usr/bin/node

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p jobs output

EXPOSE 3000

CMD ["node", "server.js"]
