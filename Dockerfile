FROM node:18-slim

# Install all system packages in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick liblcms2-2 liblcms2-dev ghostscript \
    python3 python3-pip python3-venv \
    libvips-dev libjpeg-dev libpng-dev libtiff-dev libwebp-dev \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python rembg
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir rembg[cpu] onnxruntime filetype watchdog asyncer pillow scikit-image scipy numpy

ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# Install bun
RUN npm install -g bun

# Copy and install deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build
RUN bun run build

# Copy static files for standalone
RUN cp -r .next/static .next/standalone/.next/ \
    && cp -r public .next/standalone/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

WORKDIR /app/.next/standalone
CMD ["node", "server.js"]
