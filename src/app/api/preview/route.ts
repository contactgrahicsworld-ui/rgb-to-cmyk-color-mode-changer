import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
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
  const uuidRe = /^[a-f0-9-]{36}$/i;
  const pageIdRe = /^page_\d+$/;
  if (!uuidRe.test(sessionId)) {
    return NextResponse.json({ ok: false, error: "Invalid session ID." }, { status: 400 });
  }
  if (!uuidRe.test(fileId) && !pageIdRe.test(fileId)) {
    return NextResponse.json({ ok: false, error: "Invalid file ID." }, { status: 400 });
  }

  const candidatePaths = [join(TMP_ROOT, sessionId, `${fileId}_preview.jpg`)];

  let filePath: string | null = null;
  for (const p of candidatePaths) {
    try {
      const s = await stat(p);
      if (s.isFile() && s.size > 0) { filePath = p; break; }
    } catch {}
  }

  if (!filePath) {
    return NextResponse.json({ ok: false, error: "File not found or expired." }, { status: 404 });
  }

  const buf = await readFile(filePath);
  return new NextResponse(buf as any, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-store",
    },
  });
}
