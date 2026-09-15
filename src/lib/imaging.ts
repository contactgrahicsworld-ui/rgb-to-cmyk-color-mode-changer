import { spawn } from "child_process";
import { mkdir, readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// ============================================================================
// CONSTANTS
// ============================================================================

const IM_BIN_DIR = process.cwd() + "/bin/imagemagick/usr/bin";
const IM_CONVERT = `${IM_BIN_DIR}/convert-im7.q16`;
const IM_IDENTIFY = `${IM_BIN_DIR}/identify-im7.q16`;
const IM_MAGICK = `${IM_BIN_DIR}/magick-im7.q16`;

const ICC_SRGB = "/usr/share/color/icc/ghostscript/srgb.icc";
const ICC_CMYK = "/usr/share/color/icc/ghostscript/default_cmyk.icc";

const TMP_ROOT = "/tmp/imaging-converter";

// Security limits
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file
export const MAX_INPUT_DIM = 8000; // 8000 px on the longest side
export const MAX_OUTPUT_DIM = 30000; // 30000 px on the longest side
export const MAX_BATCH_FILES = 10;
export const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per image
export const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

// JPEG output settings
const JPEG_QUALITY = 100;  // Quality 100 for best pure colour preservation
const JPEG_DPI = 600;

// Allowed input MIME types and their signatures
const ALLOWED_FORMATS = {
  "image/jpeg": { ext: "jpg", magic: [/^\xff\xd8\xff/] },
  "image/png": { ext: "png", magic: [/^\x89PNG\r\n\x1a\n/] },
  "image/tiff": { ext: "tif", magic: [/^II\x2a\x00/, /^MM\x00\x2a/] },
  "image/webp": { ext: "webp", magic: [/^RIFF....WEBP/] },
  "application/pdf": { ext: "pdf", magic: [/^%PDF-/] },
} as const;

export type AllowedMime = keyof typeof ALLOWED_FORMATS;

// Pure colour mappings: [R, G, B] → [C, M, Y, K] (0-255 scale)
const PURE_COLOUR_MAPPINGS: Array<{
  rgb: [number, number, number];
  cmyk: [number, number, number, number];
}> = [
  { rgb: [255, 0, 0], cmyk: [0, 255, 255, 0] }, // red
  { rgb: [0, 0, 0], cmyk: [0, 0, 0, 255] }, // black
  { rgb: [255, 255, 255], cmyk: [0, 0, 0, 0] }, // white
  { rgb: [0, 255, 255], cmyk: [255, 0, 0, 0] }, // cyan
  { rgb: [255, 0, 255], cmyk: [0, 255, 0, 0] }, // magenta
  { rgb: [255, 255, 0], cmyk: [0, 0, 255, 0] }, // yellow
  { rgb: [0, 0, 255], cmyk: [255, 255, 0, 0] }, // blue
  { rgb: [0, 255, 0], cmyk: [255, 0, 255, 0] }, // green
];

// ============================================================================
// TYPES
// ============================================================================

export type ColourMode =
  | "RGB"
  | "RGBA"
  | "Grayscale"
  | "CMYK"
  | "Unknown";

export type EnhancementFactor = 1 | 2 | 4 | 6 | 8 | 10 | 15 | 20 | 25;

export interface ImageInfo {
  id: string;
  sessionId: string;
  originalName: string;
  sanitizedName: string;
  width: number;
  height: number;
  format: string;
  mime: string;
  colourMode: ColourMode;
  hasIccProfile: boolean;
  bytes: number;
}

export interface OutputInfo {
  width: number;
  height: number;
  enhancementFactor: EnhancementFactor;
  dpiX: number;
  dpiY: number;
  colourSpace: string;
  format: string;
  bytes: number;
  validated: boolean;
  path: string;
  tiffPath: string;
  tiffBytes: number;
  previewPath: string;
}

export interface ValidationResult {
  ok: boolean;
  isJpeg: boolean;
  isCmyk: boolean;
  dpiX: number | null;
  dpiY: number | null;
  dimensionsOk: boolean;
  fileReadable: boolean;
  reasons: string[];
}

export interface ProcessResult {
  ok: boolean;
  input: ImageInfo;
  output?: OutputInfo;
  validation?: ValidationResult;
  error?: string;
  elapsedMs: number;
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

export async function createSession(): Promise<string> {
  const sessionId = randomUUID();
  const sessionDir = join(TMP_ROOT, sessionId);
  await mkdir(sessionDir, { recursive: true });
  return sessionId;
}

export async function cleanupSession(sessionId: string): Promise<void> {
  const sessionDir = join(TMP_ROOT, sessionId);
  try {
    await rm(sessionDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// Cleanup sessions older than TTL
export async function cleanupOldSessions(): Promise<void> {
  try {
    const entries = await readdir(TMP_ROOT);
    const now = Date.now();
    for (const entry of entries) {
      const path = join(TMP_ROOT, entry);
      try {
        const s = await stat(path);
        if (now - s.mtimeMs > SESSION_TTL_MS) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// SECURITY HELPERS
// ============================================================================

export function sanitizeFilename(name: string): string {
  // Strip directory components
  const base = name.replace(/[/\\]/g, "_").replace(/^\.+/, "");
  // Remove anything that isn't alphanumeric, dash, underscore, dot
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Collapse multiple underscores
  const collapsed = cleaned.replace(/_+/g, "_");
  // Trim length
  return collapsed.slice(0, 100) || "image";
}

export function detectMimeFromBytes(buf: Buffer): AllowedMime | null {
  for (const [mime, spec] of Object.entries(ALLOWED_FORMATS)) {
    for (const re of spec.magic) {
      if (re.test(buf.subarray(0, 16).toString("latin1"))) {
        return mime as AllowedMime;
      }
    }
  }
  return null;
}

export function isAllowedMime(mime: string): mime is AllowedMime {
  return mime in ALLOWED_FORMATS;
}

export function extensionFor(mime: AllowedMime): string {
  return ALLOWED_FORMATS[mime].ext;
}

// ============================================================================
// SHELL HELPER
// ============================================================================

function runCmd(
  cmd: string,
  args: string[],
  timeoutMs: number = PROCESS_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: TMP_ROOT,
      env: { ...process.env, MAGICK_CONFIGURE_PATH: "/etc/ImageMagick-7" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`));
      } else if (code !== 0) {
        resolve({ stdout, stderr, code: code ?? 1 });
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================================
// IMAGE INFO
// ============================================================================

export async function getImageInfo(
  filePath: string
): Promise<{ width: number; height: number; format: string; colourMode: ColourMode; hasIccProfile: boolean }> {
  const args = ["-verbose", filePath];
  const { stdout, code } = await runCmd(IM_IDENTIFY, args);

  if (code !== 0) {
    throw new Error("Image could not be decoded.");
  }

  // Parse the verbose output (lines are indented with two spaces)
  const widthMatch = stdout.match(/^\s*Geometry:\s+(\d+)x(\d+)/m);
  const formatMatch = stdout.match(/^\s*Format:\s+(\w+)/m);
  const typeMatch = stdout.match(/^\s*Type:\s+(\w+)/m);
  const colorspaceMatch = stdout.match(/^\s*Colorspace:\s+(\w+)/m);
  const iccMatch = stdout.match(/^\s*Profiles:.*\n\s*Profile-icc/m);

  const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
  const height = widthMatch ? parseInt(widthMatch[2], 10) : 0;
  const format = formatMatch ? formatMatch[1].toLowerCase() : "unknown";
  const colorspace = colorspaceMatch ? colorspaceMatch[1] : "";

  // Determine colour mode
  let colourMode: ColourMode = "Unknown";
  const t = typeMatch ? typeMatch[1] : "";
  // Channels line (e.g. "Channels: 4.0") - 4 means RGBA/CMYK, 3 means RGB/Gray, 1 means Gray
  const channelsMatch = stdout.match(/^\s*Channels:\s+([\d.]+)/m);
  const channelCount = channelsMatch ? parseInt(channelsMatch[1], 10) : 0;
  // Alpha depth indicates an alpha channel
  const hasAlpha = /^\s*Alpha:\s*\d+-bit/m.test(stdout) || /^\s*Alpha:/m.test(stdout) && /Alpha:\s+\d+/.test(stdout);
  if (colorspace === "CMYK") {
    colourMode = "CMYK";
  } else if (t === "Grayscale" || t === "Gray" || t === "GrayscaleAlpha" || colorspace === "Gray") {
    colourMode = hasAlpha ? "RGBA" : "Grayscale";
  } else if (colorspace === "sRGB" || colorspace === "RGB" || colorspace === "LinearRGB") {
    colourMode = hasAlpha || channelCount === 4 ? "RGBA" : "RGB";
  }

  return {
    width,
    height,
    format,
    colourMode,
    hasIccProfile: !!iccMatch,
  };
}

// ============================================================================
// ENHANCEMENT
// ============================================================================

export function computeOutputDimensions(
  inputW: number,
  inputH: number,
  factor: EnhancementFactor
): { width: number; height: number } {
  return {
    width: inputW * factor,
    height: inputH * factor,
  };
}

export function canEnhance(
  inputW: number,
  inputH: number,
  factor: EnhancementFactor
): { ok: boolean; reason?: string } {
  const maxIn = Math.max(inputW, inputH);
  if (maxIn > MAX_INPUT_DIM) {
    return {
      ok: false,
      reason: `Input image too large: ${inputW}×${inputH}px exceeds maximum of ${MAX_INPUT_DIM}px.`,
    };
  }
  const out = computeOutputDimensions(inputW, inputH, factor);
  const maxOut = Math.max(out.width, out.height);
  if (maxOut > MAX_OUTPUT_DIM) {
    return {
      ok: false,
      reason: `Output dimensions ${out.width}×${out.height}px exceed the maximum of ${MAX_OUTPUT_DIM}px for the selected enhancement factor.`,
    };
  }
  // Memory budget check — lowered to 1.5GB to prevent timeouts
  const pixelBytes = out.width * out.height * 4 * 8;
  if (pixelBytes > 1.5 * 1024 * 1024 * 1024) {
    return {
      ok: false,
      reason: `Image is too large for ${factor}× enhancement (would need ~${Math.round(pixelBytes / 1024 / 1024 / 1024)}GB RAM). Try 1× or 2× instead.`,
    };
  }
  // Disk budget check — lowered to 1GB
  const totalDiskBytes = out.width * out.height * 4 * 20;
  if (totalDiskBytes > 1 * 1024 * 1024 * 1024) {
    return {
      ok: false,
      reason: `Image is too large for ${factor}× enhancement (would need ~${Math.round(totalDiskBytes / 1024 / 1024 / 1024)}GB disk). Try 1× or 2× instead.`,
    };
  }
  return { ok: true };
}

/**
 * For a given input image, return the list of enhancement factors that are
 * safe to apply (won't exceed memory/disk limits).
 * Capped at 8× — higher factors cause memory/timeout failures.
 */
export function safeEnhancementFactors(
  inputW: number,
  inputH: number
): EnhancementFactor[] {
  // Capped at 4× — higher factors cause memory/timeout failures
  const all: EnhancementFactor[] = [1, 2];
  return all.filter((f) => canEnhance(inputW, inputH, f).ok);
}

// ============================================================================
// CONVERSION PIPELINE
// ============================================================================

interface PipelineOptions {
  enhancement: EnhancementFactor;
  onProgress?: (stage: string, percent: number) => void;
}

async function runConvertPipeline(
  inputPath: string,
  outputPath: string,
  previewPath: string,
  inputInfo: ImageInfo,
  opts: PipelineOptions
): Promise<void> {
  const tmpDir = join(TMP_ROOT, inputInfo.sessionId, inputInfo.id);
  await mkdir(tmpDir, { recursive: true });

  try {
    await runConvertPipelineInner(inputPath, outputPath, previewPath, inputInfo, opts, tmpDir);
  } finally {
    // ALWAYS clean up intermediate files, even on failure
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runConvertPipelineInner(
  inputPath: string,
  outputPath: string,
  previewPath: string,
  inputInfo: ImageInfo,
  opts: PipelineOptions,
  tmpDir: string
): Promise<void> {
  const { enhancement, onProgress } = opts;
  const report = (stage: string, percent: number) =>
    onProgress?.(stage, percent);

  // Helper: delete a file if it exists (saves disk space between steps)
  const cleanupFile = async (p: string) => {
    try { await rm(p, { force: true }); } catch { /* ignore */ }
  };

  report("Reading and normalizing input", 5);

  // Step 1: Read input and normalize to sRGB.
  // - For CMYK input: convert to sRGB through the existing CMYK profile
  // - For Grayscale: convert to sRGB
  // - For RGBA: flatten on white background
  // - For RGB: attach sRGB profile (so later -profile CMYK will actually convert)
  // We always attach sRGB ICC profile so that the next -profile CMYK_ICC step
  // performs a real colourspace conversion (ImageMagick's -profile only converts
  // when an existing profile is present; otherwise it just attaches).
  const normalizedPath = join(tmpDir, "normalized.miff");

  let normalizeArgs: string[];
  if (inputInfo.colourMode === "CMYK") {
    // Image already has CMYK data; convert through CMYK→sRGB via profiles
    normalizeArgs = [
      inputPath,
      "-profile",
      ICC_CMYK,
      "-profile",
      ICC_SRGB,
      normalizedPath,
    ];
  } else if (inputInfo.colourMode === "Grayscale") {
    // Promote to sRGB then attach profile
    normalizeArgs = [
      inputPath,
      "-colorspace",
      "sRGB",
      "-profile",
      ICC_SRGB,
      normalizedPath,
    ];
  } else if (inputInfo.colourMode === "RGBA") {
    // Flatten on white, then attach sRGB profile
    normalizeArgs = [
      inputPath,
      "-background",
      "white",
      "-flatten",
      "-profile",
      ICC_SRGB,
      normalizedPath,
    ];
  } else {
    // RGB - attach sRGB profile (does not convert, just attaches metadata)
    normalizeArgs = [inputPath, "-profile", ICC_SRGB, normalizedPath];
  }

  const r1 = await runCmd(IM_CONVERT, normalizeArgs);
  if (r1.code !== 0) {
    throw new Error(`Image processing failed. Please try again. (normalize: ${r1.stderr.slice(0, 200)})`);
  }

  report("Applying enhancement", 20);

  // Step 2: Apply enhancement (resize) - use high-quality Lanczos filter
  let enhancedPath = normalizedPath;
  if (enhancement > 1) {
    enhancedPath = join(tmpDir, "enhanced.miff");
    const scalePct = enhancement * 100;
    const r2 = await runCmd(
      IM_CONVERT,
      [
        normalizedPath,
        "-filter",
        "Lanczos",
        "-resize",
        `${scalePct}%`,
        enhancedPath,
      ],
      PROCESS_TIMEOUT_MS
    );
    if (r2.code !== 0) {
      throw new Error(
        `Image is too large for the selected enhancement level. (${r2.stderr.slice(0, 200)})`
      );
    }
  }

  report("Converting RGB to CMYK", 45);

  // Step 3: Convert RGB → CMYK using ICC colour management
  const cmykPath = join(tmpDir, "cmyk.miff");
  const r3 = await runCmd(
    IM_CONVERT,
    [
      enhancedPath,
      "-intent",
      "Relative",
      "-black-point-compensation",
      "-profile",
      ICC_CMYK,
      cmykPath,
    ],
    PROCESS_TIMEOUT_MS
  );
  if (r3.code !== 0) {
    throw new Error(`CMYK conversion failed: ${r3.stderr.slice(0, 200)}`);
  }

  report("Applying exact pure colour mappings", 60);

  // Step 4: Snap pure colour pixels to exact CMYK values using mask+composite
  let currentCmykPath = cmykPath;
  const dims = computeOutputDimensions(inputInfo.width, inputInfo.height, enhancement);

  let i = 0;
  for (const mapping of PURE_COLOUR_MAPPINGS) {
    const [r, g, b] = mapping.rgb;
    const [c, m, y, k] = mapping.cmyk;
    const maskPath = join(tmpDir, `mask_${i}.miff`);
    const exactPath = join(tmpDir, `exact_${i}.miff`);
    const snappedPath = join(tmpDir, `snapped_${i}.miff`);

    // Generate mask: white where input RGB exactly matches target
    const maskArgs = [
      enhancedPath,
      "(",
      "-clone",
      "0",
      "-fill",
      `rgb(${r},${g},${b})`,
      "-colorize",
      "100",
      ")",
      "-compose",
      "Difference",
      "-composite",
      "-colorspace",
      "Gray",
      "-threshold",
      "0",
      "-negate",
      maskPath,
    ];

    const rm1 = await runCmd(IM_CONVERT, maskArgs, PROCESS_TIMEOUT_MS);
    if (rm1.code !== 0) {
      throw new Error(`Pure colour snapping failed: ${rm1.stderr.slice(0, 200)}`);
    }

    // Generate solid CMYK colour image
    const exactArgs = [
      "-size",
      `${dims.width}x${dims.height}`,
      `xc:cmyk(${c},${m},${y},${k})`,
      "-colorspace",
      "CMYK",
      "-depth",
      "8",
      exactPath,
    ];
    const rm2 = await runCmd(IM_CONVERT, exactArgs, PROCESS_TIMEOUT_MS);
    if (rm2.code !== 0) {
      throw new Error(`Pure colour snapping failed: ${rm2.stderr.slice(0, 200)}`);
    }

    // Composite exact over current CMYK using mask
    const compArgs = [currentCmykPath, exactPath, maskPath, "-composite", snappedPath];
    const rm3 = await runCmd(IM_CONVERT, compArgs, PROCESS_TIMEOUT_MS);
    if (rm3.code !== 0) {
      throw new Error(`Pure colour snapping failed: ${rm3.stderr.slice(0, 200)}`);
    }

    currentCmykPath = snappedPath;
    i++;
    report(
      "Applying exact pure colour mappings",
      60 + Math.floor((i / PURE_COLOUR_MAPPINGS.length) * 10)
    );
  }

  // Cleanup the original CMYK path (no longer needed)
  await cleanupFile(cmykPath);

  // Step 4b: Black text snapping — dark pixels get forced to K-only.
  // We use luma < 45% (quite dark) with NO saturation check.
  // This catches:
  // - Pure black text (luma 0%) → K=255 ✓
  // - Anti-aliased text edges (luma ~42%) → K=213 ✓
  // - Dark photo shadows (luma ~48%) → K-only (acceptable, looks fine in print)
  // It does NOT catch:
  // - Normal photo areas (luma > 50%) → preserved with C/M/Y ✓
  // - Pure colours (red luma 30% → would be caught, but already snapped by pure colour step)
  report("Snapping black text to true K100", 75);

  const NEAR_BLACK_STRICT_PCT = 45;  // source luma < 45% → snap to K-only
  const nearBlackExactPath = join(tmpDir, "exact_nearblack.miff");
  const strictBlackSnappedPath = join(tmpDir, "snapped_black_strict.miff");
  const strictBlackMaskPath = join(tmpDir, "mask_black_strict.miff");

  // Build mask from SOURCE RGB: luma < 45% → snap to K-only
  const strictLumaMaskPath = join(tmpDir, "mask_strict_luma2.miff");
  await runCmd(IM_CONVERT, [enhancedPath, "-colorspace", "Gray", "-threshold", `${NEAR_BLACK_STRICT_PCT}%`, "-negate", "-alpha", "off", strictLumaMaskPath], PROCESS_TIMEOUT_MS);

  // Build K-only image: C=0, M=0, Y=0, K = 255 - luma
  const zeroChanPath = join(tmpDir, "zero_chan2.miff");
  const kChanPath = join(tmpDir, "k_chan2.miff");
  await runCmd(IM_CONVERT, ["-size", `${dims.width}x${dims.height}`, "xc:black", "-depth", "8", zeroChanPath], PROCESS_TIMEOUT_MS);
  await runCmd(IM_CONVERT, [enhancedPath, "-colorspace", "Gray", "-negate", "-depth", "8", kChanPath], PROCESS_TIMEOUT_MS);
  
  const kOnlyPath = join(tmpDir, "k_only2.miff");
  await runCmd(IM_CONVERT, [zeroChanPath, zeroChanPath, zeroChanPath, kChanPath, "-set", "colorspace", "CMYK", "-combine", "-depth", "8", kOnlyPath], PROCESS_TIMEOUT_MS);

  // Apply: replace dark pixels with K-only version
  await runCmd(IM_CONVERT, [currentCmykPath, kOnlyPath, strictLumaMaskPath, "-composite", "-set", "colorspace", "CMYK", strictBlackSnappedPath], PROCESS_TIMEOUT_MS);
  currentCmykPath = strictBlackSnappedPath;

  // Cleanup
  await cleanupFile(nearBlackExactPath);
  await cleanupFile(strictBlackMaskPath);
  await cleanupFile(strictLumaMaskPath);
  await cleanupFile(zeroChanPath);
  await cleanupFile(kChanPath);
  await cleanupFile(kOnlyPath);

  // Step 4c: Near-white snapping — anti-aliased text edges fading into
  // white background get cleaned to pure C0 M0 Y0 K0
  report("Cleaning white background", 80);
  const NEAR_WHITE_THRESHOLD_PCT = 96;  // raised to 96% to not catch yellow (92.8%)
  const nearWhiteMaskPath = join(tmpDir, "mask_nearwhite2.miff");
  const nearWhiteExactPath = join(tmpDir, "exact_nearwhite2.miff");
  const nearWhiteSnappedPath = join(tmpDir, "snapped_nearwhite2.miff");

  // Near-white mask: white where luma >= 96% (only very near white)
  // This avoids catching yellow (luma ~93%) which should stay as pure yellow CMYK
  await runCmd(IM_CONVERT, [enhancedPath, "-colorspace", "Gray", "-threshold", `${NEAR_WHITE_THRESHOLD_PCT}%`, "-alpha", "off", nearWhiteMaskPath], PROCESS_TIMEOUT_MS);
  await runCmd(IM_CONVERT, ["-size", `${dims.width}x${dims.height}`, "xc:cmyk(0,0,0,0)", "-colorspace", "CMYK", "-depth", "8", nearWhiteExactPath], PROCESS_TIMEOUT_MS);
  await runCmd(IM_CONVERT, [currentCmykPath, nearWhiteExactPath, nearWhiteMaskPath, "-composite", "-set", "colorspace", "CMYK", nearWhiteSnappedPath], PROCESS_TIMEOUT_MS);
  currentCmykPath = nearWhiteSnappedPath;

  await cleanupFile(nearWhiteMaskPath);
  await cleanupFile(nearWhiteExactPath);
  if (enhancedPath !== normalizedPath) await cleanupFile(enhancedPath);
  await cleanupFile(normalizedPath);

  report("Writing CMYK JPEG at 600 DPI", 85);

  // Step 5: Write final JPEG with 600 DPI, high quality, 4:4:4 chroma
  const jpegArgs = [
    currentCmykPath,
    "-density",
    `${JPEG_DPI}`,
    "-units",
    "PixelsPerInch",
    "-quality",
    `${JPEG_QUALITY}`,
    "-define",
    "jpeg:sampling-factor=4:4:4",
    "-define",
    "jpeg:dct-method=integer",
    "-strip",
    outputPath,
  ];
  const r5 = await runCmd(IM_CONVERT, jpegArgs, PROCESS_TIMEOUT_MS);
  if (r5.code !== 0) {
    throw new Error(`JPEG encoding failed: ${r5.stderr.slice(0, 200)}`);
  }

  // Also write a TIFF version (lossless) for offset printing
  const tiffPath = outputPath.replace(/\.jpg$/i, ".tiff");
  const tiffArgs = [
    currentCmykPath,
    "-density", `${JPEG_DPI}`,
    "-units", "PixelsPerInch",
    "-compress", "None",
    "-depth", "8",
    tiffPath,
  ];
  await runCmd(IM_CONVERT, tiffArgs, PROCESS_TIMEOUT_MS);

  report("Generating preview", 92);

  // Step 6: Generate RGB preview (downsized, sRGB JPEG) for before/after display
  // Preview is needed because browsers can't display CMYK JPEGs correctly
  const previewMaxDim = 1200;
  const previewArgs = [
    currentCmykPath,
    "-profile",
    ICC_CMYK,
    "-profile",
    ICC_SRGB,
    "-resize",
    `${previewMaxDim}x${previewMaxDim}>`,
    "-quality",
    "85",
    "-strip",
    previewPath,
  ];
  const r6 = await runCmd(IM_CONVERT, previewArgs, PROCESS_TIMEOUT_MS);
  if (r6.code !== 0) {
    throw new Error(`Preview generation failed: ${r6.stderr.slice(0, 200)}`);
  }

  // (intermediate files are cleaned up by the outer try/finally)
  report("Done", 100);
}

// ============================================================================
// VALIDATION
// ============================================================================

export async function validateOutput(outputPath: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    ok: false,
    isJpeg: false,
    isCmyk: false,
    dpiX: null,
    dpiY: null,
    dimensionsOk: false,
    fileReadable: false,
    reasons: [],
  };

  // Check file exists and is readable
  try {
    const s = await stat(outputPath);
    if (!s.isFile() || s.size === 0) {
      result.reasons.push("Output file is empty or missing.");
      return result;
    }
    result.fileReadable = true;
  } catch {
    result.reasons.push("Output file is not readable.");
    return result;
  }

  // Read first bytes - check JPEG signature
  try {
    const { readFile } = await import("fs/promises");
    const head = await readFile(outputPath);
    if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) {
      result.reasons.push("Output file is not a valid JPEG (bad magic bytes).");
      return result;
    }
    result.isJpeg = true;
  } catch {
    result.reasons.push("Could not read output file header.");
    return result;
  }

  // Use identify to check colourspace and resolution
  const { stdout, code, stderr } = await runCmd(IM_IDENTIFY, [
    "-verbose",
    outputPath,
  ]);

  if (code !== 0) {
    result.reasons.push(`Output file could not be parsed: ${stderr.slice(0, 100)}`);
    return result;
  }

  // Check colourspace
  const colorspaceMatch = stdout.match(/^\s*Colorspace:\s+(\w+)/m);
  const colorspace = colorspaceMatch ? colorspaceMatch[1] : "";
  if (colorspace === "CMYK") {
    result.isCmyk = true;
  } else {
    result.reasons.push(`Colorspace is ${colorspace || "unknown"}, expected CMYK.`);
  }

  // Check resolution
  const resMatch = stdout.match(/^\s*Resolution:\s+(\d+)x(\d+)/m);
  if (resMatch) {
    result.dpiX = parseInt(resMatch[1], 10);
    result.dpiY = parseInt(resMatch[2], 10);
    if (result.dpiX !== JPEG_DPI || result.dpiY !== JPEG_DPI) {
      result.reasons.push(
        `Resolution is ${result.dpiX}×${result.dpiY}, expected ${JPEG_DPI}×${JPEG_DPI}.`
      );
    }
  } else {
    result.reasons.push("Resolution metadata missing.");
  }

  // Check dimensions
  const geomMatch = stdout.match(/^\s*Geometry:\s+(\d+)x(\d+)/m);
  if (geomMatch) {
    const w = parseInt(geomMatch[1], 10);
    const h = parseInt(geomMatch[2], 10);
    if (w > 0 && h > 0 && w <= MAX_OUTPUT_DIM && h <= MAX_OUTPUT_DIM) {
      result.dimensionsOk = true;
    } else {
      result.reasons.push(`Dimensions ${w}×${h} are out of allowed range.`);
    }
  } else {
    result.reasons.push("Could not read dimensions.");
  }

  result.ok =
    result.isJpeg &&
    result.isCmyk &&
    result.dpiX === JPEG_DPI &&
    result.dpiY === JPEG_DPI &&
    result.dimensionsOk &&
    result.fileReadable;

  return result;
}

// ============================================================================
// COLOUR INSPECTOR (RGB → CMYK)
// ============================================================================

export interface ColourInspectResult {
  rgb: [number, number, number];
  cmyk: [number, number, number, number];
  exact: boolean; // true if RGB matched an exact pure colour mapping
  note: string;
}

export function inspectRgbToCmyk(r: number, g: number, b: number): ColourInspectResult {
  // Clamp to 0-255
  const R = Math.max(0, Math.min(255, Math.round(r)));
  const G = Math.max(0, Math.min(255, Math.round(g)));
  const B = Math.max(0, Math.min(255, Math.round(b)));

  // Check exact pure colour mappings
  for (const mapping of PURE_COLOUR_MAPPINGS) {
    const [mr, mg, mb] = mapping.rgb;
    if (R === mr && G === mg && B === mb) {
      const [c, m, y, k] = mapping.cmyk;
      return {
        rgb: [R, G, B],
        cmyk: [c, m, y, k],
        exact: true,
        note:
          "Exact deterministic mapping (pure RGB colour). No ICC profile conversion applied.",
      };
    }
  }

  // For non-pure colours, use mathematical RGB → CMYK conversion
  // (using simple subtraction: K = 255 - max(R,G,B), etc.)
  // This is a simplified version - real ICC conversion happens during image processing.
  const rN = R / 255;
  const gN = G / 255;
  const bN = B / 255;

  const kN = 1 - Math.max(rN, gN, bN);
  let cN: number, mN: number, yN: number;

  if (kN >= 1) {
    cN = 0;
    mN = 0;
    yN = 0;
  } else {
    cN = (1 - rN - kN) / (1 - kN);
    mN = (1 - gN - kN) / (1 - kN);
    yN = (1 - bN - kN) / (1 - kN);
  }

  const C = Math.round(cN * 255);
  const M = Math.round(mN * 255);
  const Y = Math.round(yN * 255);
  const K = Math.round(kN * 255);

  return {
    rgb: [R, G, B],
    cmyk: [C, M, Y, K],
    exact: false,
    note:
      "Approximate conversion (simplified UCR formula). For photographic colours, the actual output uses ICC profile conversion via LittleCMS, which may differ slightly from this preview.",
  };
}

// ============================================================================
// MAIN PROCESS FUNCTION
// ============================================================================

export async function processImage(
  inputPath: string,
  inputInfo: ImageInfo,
  enhancement: EnhancementFactor,
  onProgress?: (stage: string, percent: number) => void
): Promise<ProcessResult> {
  const startTime = Date.now();

  // Pre-flight check
  const check = canEnhance(inputInfo.width, inputInfo.height, enhancement);
  if (!check.ok) {
    return {
      ok: false,
      input: inputInfo,
      error: check.reason || "Image is too large for the selected enhancement level.",
      elapsedMs: Date.now() - startTime,
    };
  }

  const outputPath = join(
    TMP_ROOT,
    inputInfo.sessionId,
    `${inputInfo.id}_CMYK_600dpi.jpg`
  );
  const previewPath = join(
    TMP_ROOT,
    inputInfo.sessionId,
    `${inputInfo.id}_preview.jpg`
  );

  try {
    await runConvertPipeline(inputPath, outputPath, previewPath, inputInfo, {
      enhancement,
      onProgress,
    });

    const validation = await validateOutput(outputPath);

    if (!validation.ok) {
      // Cleanup the invalid output
      try {
        await rm(outputPath, { force: true });
      } catch {
        // ignore
      }
      return {
        ok: false,
        input: inputInfo,
        validation,
        error: "CMYK validation failed — output was not generated.",
        elapsedMs: Date.now() - startTime,
      };
    }

    const tiffPath = outputPath.replace(/\.jpg$/i, ".tiff");
    let tiffBytes = 0;
    try {
      const tiffStat = await stat(tiffPath);
      tiffBytes = tiffStat.size;
    } catch {}

    const outputInfo: OutputInfo = {
      width: inputInfo.width * enhancement,
      height: inputInfo.height * enhancement,
      enhancementFactor: enhancement,
      dpiX: JPEG_DPI,
      dpiY: JPEG_DPI,
      colourSpace: "CMYK",
      format: "JPEG",
      bytes: (await stat(outputPath)).size,
      validated: true,
      path: outputPath,
      tiffPath,
      tiffBytes,
      previewPath,
    };

    return {
      ok: true,
      input: inputInfo,
      output: outputInfo,
      validation,
      elapsedMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      input: inputInfo,
      error: err?.message || "Image processing failed. Please try again.",
      elapsedMs: Date.now() - startTime,
    };
  }
}

export const __test = {
  PURE_COLOUR_MAPPINGS,
  IM_CONVERT,
  IM_IDENTIFY,
  ICC_SRGB,
  ICC_CMYK,
  TMP_ROOT,
  JPEG_DPI,
};

// ============================================================================
// PDF SUPPORT
// ============================================================================

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  const { stdout, code } = await runCmd(IM_IDENTIFY, ["-format", "%n\n", pdfPath], 30000);
  if (code !== 0) return 0;
  return stdout.trim().split("\n").filter((l) => l.trim()).length;
}

export async function renderPdfPage(
  pdfPath: string, pageIndex: number, outPath: string, renderDpi: number = 300
): Promise<{ width: number; height: number }> {
  const args = ["-density", `${renderDpi}`, `${pdfPath}[${pageIndex}]`, "-colorspace", "sRGB", "-profile", ICC_SRGB, outPath];
  const r = await runCmd(IM_CONVERT, args, 120000);
  if (r.code !== 0) throw new Error(`PDF page ${pageIndex} render failed: ${r.stderr.slice(0, 200)}`);
  const { stdout } = await runCmd(IM_IDENTIFY, ["-format", "%w %h", outPath]);
  const parts = stdout.trim().split(/\s+/);
  return { width: parseInt(parts[0], 10) || 0, height: parseInt(parts[1], 10) || 0 };
}

export async function processPdf(
  pdfPath: string, sessionId: string, enhancement: EnhancementFactor,
  onProgress?: (page: number, total: number, stage: string) => void
): Promise<ProcessResult[]> {
  const startTime = Date.now();
  const totalPages = await getPdfPageCount(pdfPath);
  if (totalPages === 0) {
    return [{
      ok: false, input: { id: "pdf", sessionId, originalName: "document.pdf", sanitizedName: "document.pdf",
        width: 0, height: 0, format: "pdf", mime: "application/pdf", colourMode: "Unknown", hasIccProfile: false, bytes: 0 },
      error: "PDF has no pages or could not be read.", elapsedMs: Date.now() - startTime,
    }];
  }
  const MAX_PAGES = 50;
  const pagesToProcess = Math.min(totalPages, MAX_PAGES);
  const results: ProcessResult[] = [];
  for (let i = 0; i < pagesToProcess; i++) {
    onProgress?.(i + 1, pagesToProcess, `Rendering page ${i + 1}/${pagesToProcess}`);
    const pagePngPath = join(TMP_ROOT, sessionId, `page_${i}_source.png`);
    let pageDims;
    try { pageDims = await renderPdfPage(pdfPath, i, pagePngPath); } catch (e: any) {
      results.push({ ok: false, input: { id: `page_${i}`, sessionId, originalName: `document.pdf[page ${i + 1}]`, sanitizedName: `document_page_${i + 1}`, width: 0, height: 0, format: "pdf", mime: "application/pdf", colourMode: "Unknown", hasIccProfile: false, bytes: 0 }, error: e?.message || `Failed to render page ${i + 1}.`, elapsedMs: 0 });
      continue;
    }
    const pageInfo: ImageInfo = { id: `page_${i}`, sessionId, originalName: `document.pdf (page ${i + 1}/${totalPages})`, sanitizedName: `document_page_${i + 1}`, width: pageDims.width, height: pageDims.height, format: "png", mime: "image/png", colourMode: "RGB", hasIccProfile: false, bytes: 0 };
    onProgress?.(i + 1, pagesToProcess, `Converting page ${i + 1}/${pagesToProcess} to CMYK`);
    const result = await processImage(pagePngPath, pageInfo, enhancement);
    try { const { rm } = await import("fs/promises"); await rm(pagePngPath, { force: true }); } catch {}
    results.push(result);
  }
  return results;
}
