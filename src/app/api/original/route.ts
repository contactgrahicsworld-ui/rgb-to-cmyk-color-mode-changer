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

  if (!sessionId || !fileId) {
    return NextResponse.json({ ok: false, error: "Missing sessionId or fileId." }, { status: 400 });
  }
  if (!/^[a-f0-9-]{36}$/i.test(sessionId) || !/^[a-f0-9-]{36}$/i.test(fileId)) {
    return NextResponse.json({ ok: false, error: "Invalid session or file ID." }, { status: 400 });
  }

  const sessionDir = join(TMP_ROOT, sessionId);
  let filePath: string | null = null;
  let mime = "image/jpeg";
  try {
    const entries = await readdir(sessionDir);
    for (const e of entries) {
      if (e.startsWith(`${fileId}-original.`)) {
        const candidate = join(sessionDir, e);
        try {
          const s = await stat(candidate);
          if (s.isFile() && s.size > 0) {
            filePath = candidate;
            const ext = e.split(".").pop()?.toLowerCase();
            if (ext === "png") mime = "image/png";
            else if (ext === "tif" || ext === "tiff") mime = "image/tiff";
            else if (ext === "webp") mime = "image/webp";
            else mime = "image/jpeg";
            break;
          }
        } catch {
          // continue
        }
      }
    }
  } catch {
    // session dir doesn't exist
  }

  if (!filePath) {
    return NextResponse.json(
      { ok: false, error: "File not found or expired." },
      { status: 404 }
    );
  }

  const buf = await readFile(filePath);

  return new NextResponse(buf as any, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-store",
    },
  });
}
