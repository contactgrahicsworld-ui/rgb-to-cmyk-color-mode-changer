import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  createSession,
  cleanupOldSessions,
  sanitizeFilename,
  detectMimeFromBytes,
  extensionFor,
  getImageInfo,
  processImage,
  processPdf,
  getPdfPageCount,
  MAX_UPLOAD_BYTES,
  MAX_BATCH_FILES,
  type EnhancementFactor,
  type ImageInfo,
  type ColourMode,
} from "@/lib/imaging";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const VALID_FACTORS = new Set<EnhancementFactor>([1, 2, 4, 6, 8, 10, 15, 20, 25]);

type ErrorCode =
  | "NO_FILE"
  | "TOO_MANY_FILES"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "CORRUPT_IMAGE"
  | "DIMENSIONS_TOO_LARGE"
  | "ENHANCEMENT_TOO_LARGE"
  | "INVALID_FACTOR"
  | "NO_SESSION"
  | "PROCESSING_FAILED"
  | "VALIDATION_FAILED"
  | "INTERNAL";

interface ProcessResponseItem {
  ok: boolean;
  error?: string;
  errorCode?: ErrorCode;
  input?: ImageInfo;
  output?: {
    width: number;
    height: number;
    enhancementFactor: number;
    dpiX: number;
    dpiY: number;
    colourSpace: string;
    format: string;
    bytes: number;
    validated: boolean;
    downloadUrl: string;
    tiffDownloadUrl?: string;
    tiffBytes?: number;
    hasTiff?: boolean;
    previewUrl: string;
  };
  validation?: {
    ok: boolean;
    isJpeg: boolean;
    isCmyk: boolean;
    dpiX: number | null;
    dpiY: number | null;
    dimensionsOk: boolean;
    fileReadable: boolean;
    reasons: string[];
  };
  elapsedMs?: number;
  pages?: ProcessResponseItem[];
  isPdf?: boolean;
  totalPages?: number;
}

export async function POST(req: NextRequest) {
  await cleanupOldSessions();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, errorCode: "NO_FILE" as ErrorCode, error: "No file provided." },
      { status: 400 }
    );
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json(
      { ok: false, errorCode: "NO_FILE" as ErrorCode, error: "No file provided." },
      { status: 400 }
    );
  }
  if (files.length > MAX_BATCH_FILES) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "TOO_MANY_FILES" as ErrorCode,
        error: `Too many files. Maximum ${MAX_BATCH_FILES} files per batch.`,
      },
      { status: 400 }
    );
  }

  const factorRaw = form.get("enhancement");
  const enhancement = Number(factorRaw || 1);
  if (!VALID_FACTORS.has(enhancement as EnhancementFactor)) {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "INVALID_FACTOR" as ErrorCode,
        error: `Invalid enhancement factor. Allowed: 1, 2, 4, 6, 8, 10, 15, 20, 25.`,
      },
      { status: 400 }
    );
  }

  // Get or create session
  let sessionId = form.get("sessionId") as string | null;
  if (!sessionId || typeof sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(sessionId)) {
    sessionId = await createSession();
  }

  const sessionDir = join("/tmp/imaging-converter", sessionId);
  await mkdir(sessionDir, { recursive: true });

  const results: ProcessResponseItem[] = [];
  for (const file of files) {
    const r = await processOneFile(file, sessionId, enhancement as EnhancementFactor);
    results.push(r);
  }

  return NextResponse.json({ ok: true, sessionId, results });
}

async function processOneFile(
  file: File,
  sessionId: string,
  enhancement: EnhancementFactor
): Promise<ProcessResponseItem> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      errorCode: "FILE_TOO_LARGE",
      error: `File exceeds maximum upload size of ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
    };
  }

  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const detectedMime = detectMimeFromBytes(buf);
  if (!detectedMime) {
    return {
      ok: false,
      errorCode: "UNSUPPORTED_FORMAT",
      error: "Unsupported image format. Only JPG, PNG, TIFF and WEBP are accepted.",
    };
  }
  const mime = detectedMime;

  const fileId = randomUUID();
  const safeName = sanitizeFilename(file.name || `image.${extensionFor(mime)}`);
  const ext = extensionFor(mime);
  const originalPath = join("/tmp/imaging-converter", sessionId, `${fileId}-original.${ext}`);

  try {
    await writeFile(originalPath, buf);
  } catch {
    return {
      ok: false,
      errorCode: "INTERNAL",
      error: "Failed to store uploaded file.",
    };
  }

  // PDF special handling: render each page, convert each to CMYK separately
  if (mime === "application/pdf") {
    return await processPdfFile(file, originalPath, sessionId, enhancement, safeName);
  }

  // Standard image handling

  let info: ImageInfo;
  try {
    const detected = await getImageInfo(originalPath);
    info = {
      id: fileId,
      sessionId,
      originalName: file.name || safeName,
      sanitizedName: safeName,
      width: detected.width,
      height: detected.height,
      format: detected.format,
      mime,
      colourMode: detected.colourMode as ColourMode,
      hasIccProfile: detected.hasIccProfile,
      bytes: file.size,
    };
  } catch {
    return {
      ok: false,
      errorCode: "CORRUPT_IMAGE",
      error: "Image could not be decoded.",
    };
  }

  const result = await processImage(originalPath, info, enhancement);

  if (!result.ok) {
    let code: ErrorCode = "PROCESSING_FAILED";
    if (result.error?.includes("too large")) code = "ENHANCEMENT_TOO_LARGE";
    if (result.error?.includes("CMYK validation")) code = "VALIDATION_FAILED";
    return {
      ok: false,
      errorCode: code,
      error: result.error || "Image processing failed. Please try again.",
      input: info,
      elapsedMs: result.elapsedMs,
    };
  }

  return {
    ok: true,
    input: info,
    output: {
      width: result.output!.width,
      height: result.output!.height,
      enhancementFactor: result.output!.enhancementFactor,
      dpiX: result.output!.dpiX,
      dpiY: result.output!.dpiY,
      colourSpace: result.output!.colourSpace,
      format: result.output!.format,
      bytes: result.output!.bytes,
      validated: result.output!.validated,
      downloadUrl: `/api/download?sessionId=${sessionId}&fileId=${fileId}`,
      tiffDownloadUrl: `/api/download?sessionId=${sessionId}&fileId=${fileId}&format=tiff`,
      tiffBytes: result.output!.tiffBytes,
      hasTiff: result.output!.tiffBytes > 0,
      previewUrl: `/api/preview?sessionId=${sessionId}&fileId=${fileId}`,
    },
    validation: result.validation,
    elapsedMs: result.elapsedMs,
  };
}

/**
 * Process a PDF: render each page, convert each to CMYK, return per-page
 * results that the UI can show individually with per-page download links.
 */
async function processPdfFile(
  file: File,
  pdfPath: string,
  sessionId: string,
  enhancement: EnhancementFactor,
  safeName: string
): Promise<ProcessResponseItem> {
  let totalPages = 0;
  try {
    totalPages = await getPdfPageCount(pdfPath);
  } catch {
    return {
      ok: false,
      errorCode: "CORRUPT_IMAGE" as ErrorCode,
      error: "PDF could not be read. It may be corrupt or password-protected.",
      isPdf: true,
      totalPages: 0,
    };
  }

  if (totalPages === 0) {
    return {
      ok: false,
      errorCode: "CORRUPT_IMAGE" as ErrorCode,
      error: "PDF has no pages.",
      isPdf: true,
      totalPages: 0,
    };
  }

  const MAX_PAGES = 50;
  const pagesToProcess = Math.min(totalPages, MAX_PAGES);
  const startTime = Date.now();

  const parentInfo: ImageInfo = {
    id: randomUUID(),
    sessionId,
    originalName: file.name || safeName,
    sanitizedName: safeName,
    width: 0,
    height: 0,
    format: "pdf",
    mime: "application/pdf",
    colourMode: "Unknown",
    hasIccProfile: false,
    bytes: file.size,
  };

  const pdfResults = await processPdf(pdfPath, sessionId, enhancement);

  const pageItems: ProcessResponseItem[] = pdfResults.map((r, i) => {
    if (!r.ok) {
      return {
        ok: false,
        errorCode: "PROCESSING_FAILED" as ErrorCode,
        error: r.error || `Page ${i + 1} processing failed.`,
        input: r.input,
        elapsedMs: r.elapsedMs,
      };
    }
    const pageId = `page_${i}`;
    return {
      ok: true,
      input: r.input,
      output: {
        width: r.output!.width,
        height: r.output!.height,
        enhancementFactor: r.output!.enhancementFactor,
        dpiX: r.output!.dpiX,
        dpiY: r.output!.dpiY,
        colourSpace: r.output!.colourSpace,
        format: r.output!.format,
        bytes: r.output!.bytes,
        validated: r.output!.validated,
        downloadUrl: `/api/download?sessionId=${sessionId}&fileId=${pageId}`,
        previewUrl: `/api/preview?sessionId=${sessionId}&fileId=${pageId}`,
      },
      validation: r.validation,
      elapsedMs: r.elapsedMs,
    };
  });

  const successCount = pageItems.filter((p) => p.ok).length;

  return {
    ok: successCount > 0,
    isPdf: true,
    totalPages: pagesToProcess,
    input: parentInfo,
    pages: pageItems,
    elapsedMs: Date.now() - startTime,
    error: successCount === 0 ? "All pages failed to process." : undefined,
    errorCode: successCount === 0 ? "PROCESSING_FAILED" as ErrorCode : undefined,
  };
}
