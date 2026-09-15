import { NextRequest, NextResponse } from "next/server";
import { writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import {
  createSession,
  cleanupOldSessions,
  sanitizeFilename,
  detectMimeFromBytes,
  MAX_UPLOAD_BYTES,
} from "@/lib/imaging";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const TMP_ROOT = "/tmp/imaging-converter";

type ErrorCode =
  | "NO_FILE" | "FILE_TOO_LARGE" | "UNSUPPORTED_FORMAT"
  | "BG_REMOVE_FAILED" | "INTERNAL";

export async function POST(req: NextRequest) {
  await cleanupOldSessions();
  let form: FormData;
  try { form = await req.formData(); } catch {
    return NextResponse.json({ ok: false, errorCode: "NO_FILE" as ErrorCode, error: "No file provided." }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, errorCode: "NO_FILE" as ErrorCode, error: "No file provided." }, { status: 400 });
  }
  const file = files[0];
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ ok: false, errorCode: "FILE_TOO_LARGE" as ErrorCode, error: `File exceeds maximum size of ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` }, { status: 400 });
  }
  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  const detectedMime = detectMimeFromBytes(buf);
  if (!detectedMime) {
    return NextResponse.json({ ok: false, errorCode: "UNSUPPORTED_FORMAT" as ErrorCode, error: "Unsupported image format." }, { status: 400 });
  }
  const sessionId = await createSession();
  const sessionDir = join(TMP_ROOT, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const fileId = randomUUID();
  const ext = detectedMime.includes("jpeg") ? "jpg" : detectedMime.includes("png") ? "png" : detectedMime.includes("webp") ? "webp" : "tif";
  const uploadPath = join(sessionDir, `${fileId}-original.${ext}`);
  try { await writeFile(uploadPath, buf); } catch {
    await rm(sessionDir, { recursive: true, force: true });
    return NextResponse.json({ ok: false, errorCode: "INTERNAL" as ErrorCode, error: "Failed to store file." }, { status: 500 });
  }
  const scriptPath = "process.cwd() + "/scripts/bg_remove_one.py"";
  const outPath = join(sessionDir, `${fileId}_transparent.png`);
  try {
    const result = await spawnAsync("python3", [scriptPath, uploadPath, outPath], 4 * 60 * 1000);
    if (result.code !== 0) {
      try { await rm(uploadPath, { force: true }); } catch {}
      try { await rm(outPath, { force: true }); } catch {}
      return NextResponse.json({ ok: false, errorCode: "BG_REMOVE_FAILED" as ErrorCode, error: "Background removal failed. Please try again." }, { status: 500 });
    }
    let pngBuf: Buffer;
    try { pngBuf = await readFile(outPath); } catch {
      return NextResponse.json({ ok: false, errorCode: "BG_REMOVE_FAILED" as ErrorCode, error: "No output file." }, { status: 500 });
    }
    const stdoutLine = result.stdout.trim().split("\n").pop() || "";
    const parts = stdoutLine.split(/\s+/);
    let origW = 0, origH = 0, outW = 0, outH = 0;
    if (parts.length >= 5 && parts[0] === "OK") {
      origW = parseInt(parts[1], 10); origH = parseInt(parts[2], 10);
      outW = parseInt(parts[3], 10); outH = parseInt(parts[4], 10);
    }
    return NextResponse.json({
      ok: true, sessionId, fileId,
      input: { originalName: file.name || `image.${ext}`, width: origW, height: origH, bytes: file.size, format: ext },
      output: { width: outW, height: outH, bytes: pngBuf.length, format: "PNG", hasAlpha: true, colorspace: "sRGB",
        downloadUrl: `/api/download-bg?sessionId=${sessionId}&fileId=${fileId}`,
        previewUrl: `/api/download-bg?sessionId=${sessionId}&fileId=${fileId}` },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, errorCode: "BG_REMOVE_FAILED" as ErrorCode,
      error: err?.message?.includes("timed out") ? "Timed out. Try smaller image." : "Failed. Please try again." }, { status: 500 });
  }
}

function spawnAsync(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: join(process.cwd(), "scripts"), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code: number | null) => { clearTimeout(timer); resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr }); });
    child.on("error", (err: Error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message }); });
  });
}
