import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, rm, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { createSession, cleanupOldSessions, sanitizeFilename, detectMimeFromBytes, extensionFor, getImageInfo, canEnhance, safeEnhancementFactors, MAX_UPLOAD_BYTES, MAX_INPUT_DIM, type EnhancementFactor, type ColourMode } from "@/lib/imaging";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  await cleanupOldSessions();
  let form: FormData;
  try { form = await req.formData(); } catch {
    return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
  const file = files[0];
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ ok: false, errorCode: "FILE_TOO_LARGE", error: `File exceeds max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` }, { status: 400 });
  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  const detectedMime = detectMimeFromBytes(buf);
  if (!detectedMime) return NextResponse.json({ ok: false, errorCode: "UNSUPPORTED_FORMAT", error: "Unsupported format." }, { status: 400 });
  const sessionId = await createSession();
  const sessionDir = join("/tmp/imaging-converter", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const fileId = randomUUID();
  const safeName = sanitizeFilename(file.name || `image.${extensionFor(detectedMime)}`);
  const ext = extensionFor(detectedMime);
  const originalPath = join(sessionDir, `${fileId}-original.${ext}`);
  try { await writeFile(originalPath, buf); } catch {
    await rm(sessionDir, { recursive: true, force: true });
    return NextResponse.json({ ok: false, error: "Failed to store file." }, { status: 500 });
  }
  let info;
  try {
    const detected = await getImageInfo(originalPath);
    info = { width: detected.width, height: detected.height, format: detected.format, mime: detectedMime, colourMode: detected.colourMode as ColourMode, hasIccProfile: detected.hasIccProfile, bytes: file.size, originalName: file.name || safeName };
  } catch {
    await rm(sessionDir, { recursive: true, force: true });
    return NextResponse.json({ ok: false, errorCode: "CORRUPT_IMAGE", error: "Image could not be decoded." }, { status: 400 });
  }
  await rm(sessionDir, { recursive: true, force: true });
  const safeFactors = safeEnhancementFactors(info.width, info.height);
  const maxIn = Math.max(info.width, info.height);
  const factorChecks = [1, 2, 4, 6, 8].map((f) => {
    const check = canEnhance(info.width, info.height, f as EnhancementFactor);
    return { factor: f, safe: check.ok, reason: check.reason };
  });
  return NextResponse.json({ ok: true, info, safeFactors, factorChecks, imageTooLarge: maxIn > MAX_INPUT_DIM, maxInputDim: MAX_INPUT_DIM });
}
