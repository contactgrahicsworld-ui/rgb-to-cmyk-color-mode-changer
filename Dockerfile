FROM node:18-slim

RUN apt-get update && apt-get install -y \
    imagemagick ghostscript liblcms2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/

ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
WORKDIR /app/.next/standalone
CMD ["node", "server.js"]
