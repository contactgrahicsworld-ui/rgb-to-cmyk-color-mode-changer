# Colour Mode Converter

Professional RGB → CMYK image converter for prepress and print workflows.

## Features

### CMYK Conversion
- RGB → CMYK with ICC colour management (sRGB → CMYK via LittleCMS2)
- 8 pure colour exact mappings (red, black, white, cyan, magenta, yellow, blue, green)
- Black text K=100% for offset printing (C0 M0 Y0 K100)
- 600 × 600 DPI output (JPEG + lossless TIFF)
- Enhancement factor 1× to 8×
- PDF support (multi-page, each page converts separately)
- Batch processing

### Background Remover
- AI-powered background removal (rembg + u2net model)
- Transparent PNG output with no resolution loss
- Supports JPG, PNG, WEBP, BMP

## Tech Stack
- **Frontend**: Next.js 16, TypeScript, Tailwind CSS 4, shadcn/ui
- **Image Processing**: ImageMagick 7 + Ghostscript + LittleCMS2
- **AI Background Removal**: rembg + onnxruntime (Python)
- **Database**: Supabase (PostgreSQL)

## Local Development

### Prerequisites

1. **Node.js 18+** and **Bun**
2. **ImageMagick 7** with LCMS2 support
3. **Ghostscript** (for PDF support)
4. **Python 3.10+** with rembg (for background removal)
5. **Supabase** account

### Install ImageMagick 7 (Ubuntu/Debian)
```bash
sudo apt-get install imagemagick liblcms2-2 liblcms2-dev ghostscript
```

### Install Python dependencies for Background Remover
```bash
pip install rembg[cpu] onnxruntime filetype watchdog asyncer pillow
```

### Setup

```bash
# Install dependencies
bun install

# Set up environment variables
cp .env.example .env
# Edit .env with your Supabase credentials

# Run database migrations
bun run db:push

# Start development server
bun run dev
```

Open http://localhost:3000

## Environment Variables

```env
DATABASE_URL=your_supabase_postgres_connection_string
DIRECT_URL=your_supabase_direct_connection_string
```

## Deployment

### Vercel (with limitations)

**Note**: Vercel has the following limitations for this app:
- **ImageMagick** is not pre-installed on Vercel. You need to use a custom build step or external service.
- **Background Remover** (Python/rembg) won't work on Vercel serverless functions.
- **Timeout**: Vercel Pro plan allows max 60 seconds per function. Large images may time out.

**Recommended**: Use Render, Railway, or a VPS for full functionality.

### Render / Railway / VPS (Recommended)

These platforms support:
- Custom system packages (ImageMagick, Ghostscript)
- Python runtimes (for rembg)
- Long-running processes (no timeout limits)
- Persistent storage

## License

MIT
