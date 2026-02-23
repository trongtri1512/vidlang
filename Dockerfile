FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg libass-dev fonts-noto-cjk curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install yt-dlp
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p jobs output

EXPOSE 3000

CMD ["node", "server.js"]
