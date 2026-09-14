import { NextRequest, NextResponse } from "next/server";
import { readFile, stat, readdir } from "fs/promises";
import { join } from "path";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TMP_ROOT = "/tmp/imaging-converter";
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  const fileId = url.searchParams.get("fileId");
  if (!sessionId || !fileId) return NextResponse.json({ ok: false, error: "Missing params." }, { status: 400 });
  const uuidRe = /^[a-f0-9-]{36}$/i;
  if (!uuidRe.test(sessionId) || (!uuidRe.test(fileId) && !/^page_\d+$/.test(fileId)))
    return NextResponse.json({ ok: false, error: "Invalid ID." }, { status: 400 });
  const sessionDir = join(TMP_ROOT, sessionId);
  let filePath: string | null = null;
  try {
    const entries = await readdir(sessionDir);
    for (const e of entries) {
      if (e.startsWith(`${fileId}_transparent.`)) {
        const candidate = join(sessionDir, e);
        try { const s = await stat(candidate); if (s.isFile() && s.size > 0) { filePath = candidate; break; } } catch {}
      }
    }
  } catch {}
  if (!filePath) return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  const buf = await readFile(filePath);
  return new NextResponse(buf as any, { status: 200, headers: {
    "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${fileId}_transparent.png"`,
    "Content-Length": String(buf.length), "Cache-Control": "private, no-store" } });
}
