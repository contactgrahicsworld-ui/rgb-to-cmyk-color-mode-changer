#!/bin/bash
set -e

# Install ImageMagick and dependencies
yum install -y ImageMagick ghostscript liblcms2 lcms2-devel 2>/dev/null || \
apt-get update && apt-get install -y imagemagick ghostscript liblcms2-2 2>/dev/null || true

# Install npm dependencies
npm install

# Build Next.js
npx next build

# Copy static files
cp -r .next/static .next/standalone/.next/ 2>/dev/null || true
cp -r public .next/standalone/ 2>/dev/null || true

echo "Build complete!"
