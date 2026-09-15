FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick \
    liblcms2-2 \
    liblcms2-dev \
    ghostscript \
    python3 \
    python3-pip \
    python3-venv \
    libvips-dev \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    libwebp-dev \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# Install Python dependencies for background removal (rembg)
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir \
    rembg[cpu] \
    onnxruntime \
    filetype \
    watchdog \
    asyncer \
    pillow \
    scikit-image \
    scipy \
    numpy
ENV PATH="/opt/venv/bin:${PATH}"

# Working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy all source files
COPY . .

# Build Next.js (standalone output)
RUN bun run build

# Copy static files to standalone (required by Next.js standalone)
RUN cp -r .next/static .next/standalone/.next/ && \
    cp -r public .next/standalone/

# Pre-download the rembg u2netp model (4.5MB) so first request is fast
RUN mkdir -p /root/.rembg/models/u2netp && \
    curl -L -o /root/.rembg/models/u2netp/u2netp.onnx \
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx" || true

# Set environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Start the app
WORKDIR /app/.next/standalone
CMD ["node", "server.js"]
