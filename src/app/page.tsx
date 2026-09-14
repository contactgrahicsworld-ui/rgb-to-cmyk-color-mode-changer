"use client";

import * as React from "react";
import { useCallback, useRef, useState } from "react";
import {
  Upload,
  Image as ImageIcon,
  Wand2,
  Download,
  Eye,
  CheckCircle2,
  XCircle,
  Loader2,
  ZoomIn,
  ZoomOut,
  Palette,
  Layers,
  Info,
  AlertTriangle,
  Scissors,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// ============================================================================
// TYPES
// ============================================================================
type EnhancementFactor = 1 | 2 | 4 | 6 | 8 | 10 | 15 | 20 | 25;

interface ImageMeta {
  width: number;
  height: number;
  format: string;
  mime: string;
  colourMode: string;
  hasIccProfile: boolean;
  bytes: number;
  originalName: string;
}

interface PdfPageResult {
  ok: boolean;
  error?: string;
  pageIndex: number;
  pageNumber: number;
  width: number;
  height: number;
  bytes: number;
  downloadUrl: string;
  previewUrl: string;
  validated: boolean;
}

interface FileJob {
  id: string;
  file: File;
  previewUrl: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  progressStage: string;
  error?: string;
  errorCode?: string;
  meta?: ImageMeta;
  result?: {
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
  isPdf?: boolean;
  totalPages?: number;
  pdfPages?: PdfPageResult[];
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
  sessionId?: string;
}


// ============================================================================
// HELPERS
// ============================================================================
// Enhancement options capped at 4× for reliable performance
const ENHANCEMENT_OPTIONS: EnhancementFactor[] = [1, 2, 4];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function shortUuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}


function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}
function cmykCss(c: number, m: number, y: number, k: number): string {
  // For display only - approximate CMYK to RGB
  const R = Math.round(255 * (1 - c / 100) * (1 - k / 100));
  const G = Math.round(255 * (1 - m / 100) * (1 - k / 100));
  const B = Math.round(255 * (1 - y / 100) * (1 - k / 100));
  return `rgb(${R}, ${G}, ${B})`;
}

// ============================================================================
// MAIN APP
// ============================================================================
export default function Home() {
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [enhancement, setEnhancement] = useState<EnhancementFactor>(1);
  const [isDragging, setIsDragging] = useState(false);
  const [sharedSessionId, setSharedSessionId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [showPureColoursRef, setShowPureColoursRef] = useState(false);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const newJobs: FileJob[] = arr.map((f) => ({
      id: shortUuid(),
      file: f,
      previewUrl: URL.createObjectURL(f),
      status: "queued",
      progress: 0,
      progressStage: "Waiting to start",
    }));
    setJobs((prev) => [...prev, ...newJobs]);
  }, []);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const processJob = useCallback(
    async (jobId: string) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? { ...j, status: "processing", progress: 1, progressStage: "Starting..." }
            : j
        )
      );

      const job = jobs.find((j) => j.id === jobId);
      if (!job) return;

      const fd = new FormData();
      fd.append("files", job.file);
      fd.append("enhancement", String(enhancement));
      if (sharedSessionId) fd.append("sessionId", sharedSessionId);

      try {
        const resp = await fetch("/api/process", { method: "POST", body: fd });
        const data = await resp.json();

        if (!resp.ok || !data.ok) {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId
                ? {
                    ...j,
                    status: "failed",
                    progress: 100,
                    progressStage: "Failed",
                    error: data.error || "Request failed.",
                    errorCode: data.errorCode,
                  }
                : j
            )
          );
          return;
        }

        if (data.sessionId) setSharedSessionId(data.sessionId);

        const item = data.results?.[0];
        if (!item || !item.ok) {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId
                ? {
                    ...j,
                    status: "failed",
                    progress: 100,
                    progressStage: "Failed",
                    error: item?.error || "Processing failed.",
                    errorCode: item?.errorCode,
                    meta: item?.input
                      ? {
                          width: item.input.width,
                          height: item.input.height,
                          format: item.input.format,
                          mime: item.input.mime,
                          colourMode: item.input.colourMode,
                          hasIccProfile: item.input.hasIccProfile,
                          bytes: item.input.bytes,
                          originalName: item.input.originalName,
                        }
                      : undefined,
                  }
                : j
            )
          );
          return;
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? {
                  ...j,
                  status: "completed",
                  progress: 100,
                  progressStage: "Completed",
                  meta: {
                    width: item.input.width,
                    height: item.input.height,
                    format: item.input.format,
                    mime: item.input.mime,
                    colourMode: item.input.colourMode,
                    hasIccProfile: item.input.hasIccProfile,
                    bytes: item.input.bytes,
                    originalName: item.input.originalName,
                  },
                  result: item.output,
                  validation: item.validation,
                  sessionId: data.sessionId,
                  isPdf: !!item.isPdf,
                  totalPages: item.totalPages,
                  pdfPages: item.pages
                    ? item.pages.map((p: any, idx: number) => ({
                        ok: !!p.ok,
                        error: p.error,
                        pageIndex: idx,
                        pageNumber: idx + 1,
                        width: p.output?.width || 0,
                        height: p.output?.height || 0,
                        bytes: p.output?.bytes || 0,
                        downloadUrl: p.output?.downloadUrl || "",
                        previewUrl: p.output?.previewUrl || "",
                        validated: p.output?.validated || false,
                      }))
                    : undefined,
                }
              : j
          )
        );
      } catch (err: any) {
        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId
              ? {
                  ...j,
                  status: "failed",
                  progress: 100,
                  progressStage: "Failed",
                  error: "Network error. Please try again.",
                }
              : j
          )
        );
      }
    },
    [jobs, enhancement, sharedSessionId]
  );

  const processAll = useCallback(async () => {
    const queued = jobs.filter((j) => j.status === "queued");
    // Sequential to avoid overloading the server with heavy IM processes
    for (const job of queued) {
      await processJob(job.id);
    }
  }, [jobs, processJob]);

  const removeJob = (id: string) => {
    setJobs((prev) => {
      const j = prev.find((x) => x.id === id);
      if (j) URL.revokeObjectURL(j.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const clearAll = () => {
    jobs.forEach((j) => URL.revokeObjectURL(j.previewUrl));
    setJobs([]);
    setSharedSessionId(null);
  };

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const processingCount = jobs.filter((j) => j.status === "processing").length;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 dark:from-stone-950 dark:to-stone-900 text-stone-900 dark:text-stone-100">
      <header className="sticky top-0 z-40 backdrop-blur-md bg-stone-50/80 dark:bg-stone-950/80 border-b border-stone-200 dark:border-stone-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-9 sm:size-10 rounded-lg bg-gradient-to-br from-rose-500 via-amber-500 to-emerald-500 flex items-center justify-center shadow-sm shrink-0">
              <Palette className="size-5 sm:size-6 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate">
                Colour Mode Converter
              </h1>
              <p className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400 hidden xs:block sm:block">
                RGB → CMYK · 600 DPI · ICC-managed · Print-ready JPEG
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {completedCount > 0 && (
              <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800">
                <CheckCircle2 className="size-3 mr-1" />
                {completedCount} done
              </Badge>
            )}
            {failedCount > 0 && (
              <Badge variant="outline" className="text-rose-600 border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800">
                <XCircle className="size-3 mr-1" />
                {failedCount} failed
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-10 space-y-6 sm:space-y-8">
        {/* Hero / Intro */}
        <section className="space-y-2">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Convert RGB images to print-ready CMYK
          </h2>
          <p className="text-sm sm:text-base text-stone-600 dark:text-stone-400 max-w-3xl">
            Upload JPG, PNG, TIFF, WEBP or PDF. The image is colour-managed through
            ICC profiles (sRGB → CMYK via LittleCMS), pure colours are snapped
            to exact deterministic CMYK values, and the result is encoded as a
            genuine CMYK JPEG at 600 × 600 DPI. Every output is independently
            validated before download.
          </p>
        </section>

        {/* Upload card */}
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Upload className="size-4 sm:size-5" />
              Upload images
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Drop files here or click to browse. Up to 10 files per batch,
              50&nbsp;MB each. JPG, PNG, TIFF, WEBP, PDF.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "relative border-2 border-dashed rounded-lg p-6 sm:p-10 text-center cursor-pointer transition-all",
                isDragging
                  ? "border-rose-400 bg-rose-50 dark:bg-rose-950/30"
                  : "border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-600 hover:bg-stone-50 dark:hover:bg-stone-900/50"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/tiff,image/webp,application/pdf,.jpg,.jpeg,.png,.tif,.tiff,.webp,.pdf"
                onChange={onFileInputChange}
                className="sr-only"
              />
              <Upload className="mx-auto size-8 sm:size-10 text-stone-400 dark:text-stone-600 mb-3" />
              <p className="text-sm sm:text-base font-medium">
                Drop images here or click to upload
              </p>
              <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400 mt-1">
                Batch supported · Drag &amp; drop or file picker
              </p>
            </div>

            {/* Enhancement selector */}
            <div className="space-y-2">
              <Label className="text-xs sm:text-sm font-medium flex items-center gap-1.5">
                <Wand2 className="size-3.5" />
                Enhancement / upscale factor
              </Label>
              <Select
                value={String(enhancement)}
                onValueChange={(v) => setEnhancement(Number(v) as EnhancementFactor)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENHANCEMENT_OPTIONS.map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {f}× {f === 1 ? "(no enlargement)" : `— enlarge ${f}×`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400">
                Uses Lanczos resampling to preserve edges, text and logos
                without hallucination. Output dimensions are scaled by the
                selected factor; DPI is always 600.
              </p>
            </div>

            {jobs.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  onClick={processAll}
                  disabled={queuedCount === 0 || processingCount > 0}
                  className="gap-2"
                >
                  {processingCount > 0 ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Wand2 className="size-4" />
                  )}
                  {processingCount > 0
                    ? `Processing (${processingCount})...`
                    : `Convert ${queuedCount > 0 ? queuedCount : ""} to CMYK`}
                </Button>
                <Button variant="outline" onClick={clearAll} className="gap-2">
                  Clear all
                </Button>
                <div className="ml-auto flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                  <span>{jobs.length} file{jobs.length === 1 ? "" : "s"}</span>
                  <Separator orientation="vertical" className="h-4" />
                  <span>{completedCount} done</span>
                  {failedCount > 0 && (
                    <>
                      <Separator orientation="vertical" className="h-4" />
                      <span className="text-rose-600">{failedCount} failed</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Job list */}
        {jobs.length > 0 && (
          <div className="space-y-4">
            <h3 className="text-base sm:text-lg font-semibold flex items-center gap-2">
              <Layers className="size-4 sm:size-5" />
              Files
            </h3>
            <div className="grid gap-4">
              {jobs.map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  enhancement={enhancement}
                  onRemove={() => removeJob(job.id)}
                  onRetry={() => processJob(job.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Background Remover */}
        <BackgroundRemoveCard />

        {/* How to use — Hindi instructions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Info className="size-4 sm:size-5" />
              कैसे इस्तेमाल करें
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* CMYK Converter */}
            <div className="space-y-2">
              <p className="text-sm font-semibold text-stone-800 dark:text-stone-200 flex items-center gap-2">
                <span className="size-5 rounded bg-rose-500 text-white text-[10px] flex items-center justify-center font-bold">1</span>
                RGB → CMYK कलर कन्वर्टर
              </p>
              <ul className="text-xs sm:text-sm space-y-1.5 text-stone-600 dark:text-stone-400 list-disc list-inside pl-2">
                <li>ऊपर अपलोड बॉक्स में इमेज ड्रैग-ड्रॉप करें या "Choose Files" पर क्लिक करें। JPG, PNG, TIFF, WEBP और PDF सपोर्टेड हैं।</li>
                <li>इमेज का कलर मोड अपने आप डिटेक्ट हो जाएगा (RGB, RGBA, Grayscale या CMYK)।</li>
                <li>Enhancement factor चुनें — <strong>1×</strong> (बिना बढ़ाए), <strong>2×</strong> (2 गुना), या <strong>4×</strong> (4 गुना रिज़ॉल्यूशन)।</li>
                <li>"Convert to CMYK" बटन दबाएँ। इमेज ICC प्रोफाइल (sRGB → CMYK) के साथ प्रोसेस होगी।</li>
                <li>ब्लैक टेक्स्ट अपने आप <strong>C0 M0 Y0 K100</strong> हो जाएगा — ऑफ़सेट प्रिंटिंग के लिए एकदम सही।</li>
                <li>8 प्योर कलर्स (लाल, काला, सफ़ेद, सियान, मैजेंटा, पीला, नीला, हरा) एक्ज़ैक्ट CMYK वैल्यूज़ में कन्वर्ट होंगे।</li>
                <li>आउटपुट: <strong>CMYK JPEG</strong> (600×600 DPI) + <strong>TIFF</strong> (लॉसलेस, ऑफ़सेट प्रिंटिंग के लिए)।</li>
                <li>हर आउटपुट वैलिडेट होता है — JPEG फॉर्मेट, CMYK कलरस्पेस, 600 DPI, और डायमेंशन चेक होते हैं।</li>
                <li>PDF अपलोड करने पर हर पेज अलग से कन्वर्ट होगा — हर पेज का अलग JPG/TIFF डाउनलोड होगा।</li>
                <li>बैच प्रोसेसिंग: एक साथ 10 इमेजेज अपलोड करें — सब अलग-अलग प्रोसेस होंगी।</li>
              </ul>
            </div>

            <Separator />

            {/* Background Remover */}
            <div className="space-y-2">
              <p className="text-sm font-semibold text-stone-800 dark:text-stone-200 flex items-center gap-2">
                <span className="size-5 rounded bg-rose-500 text-white text-[10px] flex items-center justify-center font-bold">2</span>
                बैकग्राउंड रिमूवर (Background Remover)
              </p>
              <ul className="text-xs sm:text-sm space-y-1.5 text-stone-600 dark:text-stone-400 list-disc list-inside pl-2">
                <li>नीचे "Background Remover" सेक्शन में इमेज ड्रैग-ड्रॉप करें या "Choose Files" पर क्लिक करें। JPG, PNG, WEBP, BMP सपोर्टेड हैं।</li>
                <li>AI मॉडल (rembg + u2net) फोटो के फोरग्राउंड सब्जेक्ट को पहचानता है — जैसे इंसान, प्रोडक्ट, ऑब्जेक्ट।</li>
                <li>"Remove Background" बटन दबाएँ। 5-15 सेकंड में बैकग्राउंड हट जाएगा।</li>
                <li>आउटपुट: <strong>Transparent PNG</strong> — बैकग्राउंड पूरी तरह ट्रांसपेरेंट (alpha=0)।</li>
                <li><strong>रिज़ॉल्यूशन लॉस नहीं होता</strong> — आउटपुट की डायमेंशन इनपुट के बराबर होती हैं।</li>
                <li>बैच प्रोसेसिंग: एक साथ 5 इमेजेज अपलोड करें — सब अलग-अलग प्रोसेस होंगी।</li>
                <li>हर इमेज का अलग "Download PNG" बटन होगा।</li>
                <li>बिफोर/आफ्टर प्रीव्यू: ओरिजिनल इमेज और ट्रांसपेरेंट PNG साथ-साथ दिखेंगे।</li>
                <li>बड़ी इमेजेज (2000×2000px तक) भी सपोर्टेड हैं — AI मॉडल अपने आप मेमोरी मैनेज करता है।</li>
              </ul>
            </div>

            <Separator />

            {/* Technical Details */}
            <div className="space-y-2">
              <p className="text-sm font-semibold text-stone-800 dark:text-stone-200 flex items-center gap-2">
                <span className="size-5 rounded bg-stone-400 text-white text-[10px] flex items-center justify-center font-bold">i</span>
                तकनीकी जानकारी
              </p>
              <ul className="text-xs sm:text-sm space-y-1.5 text-stone-600 dark:text-stone-400 list-disc list-inside pl-2">
                <li>CMYK कन्वर्ज़न: ImageMagick 7 + LittleCMS2 (ICC प्रोफाइल के साथ)।</li>
                <li>बैकग्राउंड रिमूवल: rembg + u2net AI मॉडल (Python)।</li>
                <li>PDF सपोर्ट: Ghostscript (हर पेज अलग से रेंडर होता है)।</li>
                <li>ब्लैक टेक्स्ट K=100%: GCR (Gray Component Replacement) तकनीक से।</li>
                <li>TIFF आउटपुट: लॉसलेस, ऑफ़सेट प्रिंटिंग के लिए एकदम सही।</li>
                <li>Enhancement: Lanczos resampling (टेक्स्ट और लोगो प्रिज़र्व)।</li>
                <li>जेपीईजी क्वालिटी: 100 (मैक्सिमम प्योर कलर प्रिज़र्वेशन)।</li>
                <li>600 DPI: प्रिंट-रेडी आउटपुट (PixelsPerInch)।</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </main>

      <footer className="mt-auto border-t border-stone-200 dark:border-stone-800 bg-stone-50/80 dark:bg-stone-950/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 text-center text-xs text-stone-500 dark:text-stone-400">
          Server-side image engine: ImageMagick 7 + LittleCMS2 + libjpeg.
          Genuine CMYK JPEG output. Files are processed in private temp
          storage and cleaned up automatically.
        </div>
      </footer>
    </div>
  );
}

// ============================================================================
// JOB CARD
// ============================================================================
function JobCard({
  job,
  enhancement,
  onRemove,
  onRetry,
}: {
  job: FileJob;
  enhancement: EnhancementFactor;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const isProcessing = job.status === "processing";
  const isCompleted = job.status === "completed";
  const isFailed = job.status === "failed";

  const outDims = job.result
    ? `${job.result.width} × ${job.result.height} px`
    : job.meta
      ? `${job.meta.width * enhancement} × ${job.meta.height * enhancement} px (target)`
      : "—";

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 sm:p-6 space-y-4">
        {/* Top row: name + status */}
        <div className="flex items-start gap-3">
          <div className="size-12 sm:size-14 rounded-md overflow-hidden bg-stone-100 dark:bg-stone-800 flex items-center justify-center shrink-0">
            {job.previewUrl ? (
               
              <img
                src={job.previewUrl}
                alt={job.file.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <ImageIcon className="size-5 text-stone-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm sm:text-base font-medium truncate">
              {job.file.name}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {formatBytes(job.file.size)}
              {job.meta && (
                <>
                  <span className="mx-1">·</span>
                  {job.meta.width}×{job.meta.height}px
                  <span className="mx-1">·</span>
                  <span className="font-medium">{job.meta.colourMode}</span>
                  {job.meta.hasIccProfile && (
                    <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 h-4">
                      ICC
                    </Badge>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={job.status} />
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-stone-500 hover:text-stone-700"
              onClick={onRemove}
              aria-label="Remove"
            >
              <XCircle className="size-4" />
            </Button>
          </div>
        </div>

        {/* Progress */}
        {isProcessing && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-stone-500 dark:text-stone-400">
              <span>{job.progressStage}</span>
              <span>{job.progress}%</span>
            </div>
            <Progress value={job.progress} className="h-2" />
          </div>
        )}

        {/* Error */}
        {isFailed && (
          <div className="rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900 px-3 py-2 text-xs sm:text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-medium">Conversion failed</p>
              <p className="mt-0.5 break-words">{job.error}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 text-xs"
                onClick={onRetry}
              >
                Retry
              </Button>
            </div>
          </div>
        )}

        {/* Result summary */}
        {isCompleted && job.result && job.meta && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs sm:text-sm">
            <div className="space-y-0.5">
              <p className="text-stone-500 dark:text-stone-400">Original</p>
              <p className="font-medium">{job.meta.width}×{job.meta.height}px</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-stone-500 dark:text-stone-400">Enhancement</p>
              <p className="font-medium">{enhancement}×</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-stone-500 dark:text-stone-400">Output</p>
              <p className="font-medium">{outDims}</p>
            </div>
            <div className="space-y-0.5">
              <p className="text-stone-500 dark:text-stone-400">Resolution</p>
              <p className="font-medium">{job.result.dpiX}×{job.result.dpiY} DPI</p>
            </div>
          </div>
        )}

        {/* Validation chip */}
        {isCompleted && job.validation && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex items-center gap-1 font-medium">
              <CheckCircle2 className="size-3.5" />
              Output validated
            </span>
            <span>JPEG: {job.validation.isJpeg ? "✓" : "✗"}</span>
            <span>CMYK: {job.validation.isCmyk ? "✓" : "✗"}</span>
            <span>
              DPI: {job.validation.dpiX}×{job.validation.dpiY}
            </span>
            <span>Dims: {job.validation.dimensionsOk ? "✓" : "✗"}</span>
            <span>Size: {job.result ? formatBytes(job.result.bytes) : "—"}</span>
          </div>
        )}

        {/* PDF Pages */}
        {isCompleted && job.isPdf && job.pdfPages && job.pdfPages.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-medium">
                PDF Pages ({job.pdfPages.filter((p) => p.ok).length}/{job.pdfPages.length} converted)
              </p>
              <span className="text-[11px] text-stone-500 dark:text-stone-400">
                Each page downloads separately as CMYK JPG
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
              {job.pdfPages.map((page) => (
                <PdfPageCard key={page.pageIndex} page={page} />
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        {isCompleted && job.result && !job.isPdf && (
          <div className="flex flex-wrap gap-2">
            <Button asChild className="gap-2">
              <a href={job.result.downloadUrl} download>
                <Download className="size-4" />
                Download CMYK JPG
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowPreview((v) => !v)}
            >
              <Eye className="size-4" />
              {showPreview ? "Hide" : "Show"} before/after
            </Button>
          </div>
        )}

        {/* Before/After */}
        {isCompleted && job.result && !job.isPdf && showPreview && (
          <BeforeAfter
            originalUrl={job.previewUrl}
            processedUrl={job.result.previewUrl}
            originalName={job.file.name}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// STATUS BADGE
// ============================================================================
function StatusBadge({ status }: { status: FileJob["status"] }) {
  if (status === "queued")
    return (
      <Badge variant="outline" className="text-stone-500">
        Queued
      </Badge>
    );
  if (status === "processing")
    return (
      <Badge variant="outline" className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800">
        <Loader2 className="size-3 mr-1 animate-spin" />
        Processing
      </Badge>
    );
  if (status === "completed")
    return (
      <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800">
        <CheckCircle2 className="size-3 mr-1" />
        Completed
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-rose-600 border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800">
      <XCircle className="size-3 mr-1" />
      Failed
    </Badge>
  );
}

// ============================================================================
// BEFORE / AFTER PREVIEW
// ============================================================================
function BeforeAfter({
  originalUrl,
  processedUrl,
  originalName,
}: {
  originalUrl: string;
  processedUrl: string;
  originalName: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<"side" | "original" | "processed">("side");

  return (
    <div className="space-y-3 border-t border-stone-200 dark:border-stone-800 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-xs">
          <Button
            size="sm"
            variant={view === "side" ? "default" : "outline"}
            className="h-7"
            onClick={() => setView("side")}
          >
            Side by side
          </Button>
          <Button
            size="sm"
            variant={view === "original" ? "default" : "outline"}
            className="h-7"
            onClick={() => setView("original")}
          >
            Original
          </Button>
          <Button
            size="sm"
            variant={view === "processed" ? "default" : "outline"}
            className="h-7"
            onClick={() => setView("processed")}
          >
            Processed
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-7"
                  onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                >
                  <ZoomOut className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="text-xs tabular-nums w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-7"
                  onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
                >
                  <ZoomIn className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div
        className={cn(
          "grid gap-2 overflow-auto rounded-md border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900 p-2",
          view === "side" ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1"
        )}
        style={{ maxHeight: "70vh" }}
      >
        {(view === "side" || view === "original") && (
          <figure className="space-y-1">
            <div
              className="overflow-auto rounded bg-[conic-gradient(at_50%_50%,_#e5e5e5_25%,_#f5f5f5_25%_50%,_#e5e5e5_50%_75%,_#f5f5f5_75%)] bg-[length:16px_16px]"
              style={{ maxHeight: "60vh" }}
            >
              { }
              <img
                src={originalUrl}
                alt={`Original: ${originalName}`}
                style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
                className="block max-w-full h-auto"
              />
            </div>
            <figcaption className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400 px-1">
              Original (RGB)
            </figcaption>
          </figure>
        )}
        {(view === "side" || view === "processed") && (
          <figure className="space-y-1">
            <div
              className="overflow-auto rounded bg-[conic-gradient(at_50%_50%,_#e5e5e5_25%,_#f5f5f5_25%_50%,_#e5e5e5_50%_75%,_#f5f5f5_75%)] bg-[length:16px_16px]"
              style={{ maxHeight: "60vh" }}
            >
              { }
              <img
                src={processedUrl}
                alt="Processed preview (RGB rendering of CMYK output)"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}
                className="block max-w-full h-auto"
              />
            </div>
            <figcaption className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400 px-1">
              Processed (CMYK output, rendered as RGB for preview only —
              downloaded file is genuine CMYK)
            </figcaption>
          </figure>
        )}
      </div>
    </div>
  );
}
function BackgroundRemoveCard() {
  const [jobs, setJobs] = useState<BgJob[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).slice(0, 5);
    const newJobs: BgJob[] = arr.map((f) => ({
      id: shortUuid(), file: f, previewUrl: URL.createObjectURL(f), status: "queued",
    }));
    setJobs((prev) => [...prev, ...newJobs]);
  }, []);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) { addFiles(e.target.files); e.target.value = ""; }
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files?.length > 0) addFiles(e.dataTransfer.files); };
  const removeJob = (id: string) => { setJobs((prev) => { const j = prev.find((x) => x.id === id); if (j) URL.revokeObjectURL(j.previewUrl); return prev.filter((x) => x.id !== id); }); };
  const clearAll = () => { jobs.forEach((j) => URL.revokeObjectURL(j.previewUrl)); setJobs([]); };

  const processJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: "processing" } : j));
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const fd = new FormData();
    fd.append("files", job.file);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3 * 60 * 1000);
      const resp = await fetch("/api/remove-bg", { method: "POST", body: fd, signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: "failed", error: data.error || "Background removal failed.", errorCode: data.errorCode } : j));
        return;
      }
      setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: "completed", result: data.output } : j));
    } catch (err: any) {
      let errMsg = "Background removal failed. Please try again.";
      if (err?.name === "AbortError") errMsg = "Timed out (3 min). Try a smaller image.";
      else if (err?.message?.includes("Failed to fetch")) errMsg = "Connection lost. Please try again.";
      setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, status: "failed", error: errMsg } : j));
    }
  }, [jobs]);

  const processAll = useCallback(async () => {
    const queued = jobs.filter((j) => j.status === "queued");
    for (const job of queued) { await processJob(job.id); }
  }, [jobs, processJob]);

  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const processingCount = jobs.filter((j) => j.status === "processing").length;
  const queuedCount = jobs.filter((j) => j.status === "queued").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Scissors className="size-4 sm:size-5 text-rose-500" />
          Background Remover
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Remove the background from any photo and get a transparent PNG
          with full resolution preserved. Powered by AI (rembg + u2net model).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "relative border-2 border-dashed rounded-lg p-4 sm:p-6 text-center cursor-pointer transition-all",
            isDragging ? "border-rose-400 bg-rose-50 dark:bg-rose-950/30" : "border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-600 hover:bg-stone-50 dark:hover:bg-stone-900/50"
          )}
        >
          <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp,.jpg,.jpeg,.png,.webp,.bmp" onChange={onFileInputChange} className="sr-only" />
          <Scissors className="mx-auto size-6 sm:size-8 text-stone-400 dark:text-stone-600 mb-2" />
          <p className="text-sm sm:text-base font-medium">Drop image here to remove background</p>
          <p className="text-xs sm:text-sm text-stone-500 dark:text-stone-400 mt-1">JPG, PNG, WEBP, BMP · Up to 5 images · 50MB each</p>
        </div>
        {jobs.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button onClick={processAll} disabled={queuedCount === 0 || processingCount > 0} className="gap-2" size="sm">
                {processingCount > 0 ? <Loader2 className="size-4 animate-spin" /> : <Scissors className="size-4" />}
                {processingCount > 0 ? `Removing (${processingCount})...` : `Remove Background${queuedCount > 0 ? ` (${queuedCount})` : ""}`}
              </Button>
              <Button variant="outline" size="sm" onClick={clearAll} className="gap-2">Clear all</Button>
              <div className="ml-auto flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                <span>{jobs.length} file{jobs.length === 1 ? "" : "s"}</span>
                {completedCount > 0 && (<><Separator orientation="vertical" className="h-4" /><span className="text-emerald-600">{completedCount} done</span></>)}
                {failedCount > 0 && (<><Separator orientation="vertical" className="h-4" /><span className="text-rose-600">{failedCount} failed</span></>)}
              </div>
            </div>
            <div className="grid gap-3">
              {jobs.map((job) => (
                <BgJobCard key={job.id} job={job} onRemove={() => removeJob(job.id)} onRetry={() => processJob(job.id)} />
              ))}
            </div>
          </>
        )}
        <p className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400">
          The AI model identifies the foreground subject (person, product, object) and removes everything else.
          Output is a transparent PNG with the same resolution as the input — no quality loss.
        </p>
      </CardContent>
    </Card>
  );
}

function BgJobCard({ job, onRemove, onRetry }: { job: BgJob; onRemove: () => void; onRetry: () => void; }) {
  const [showPreview, setShowPreview] = useState(false);
  const isProcessing = job.status === "processing";
  const isCompleted = job.status === "completed";
  const isFailed = job.status === "failed";
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-800 p-3 sm:p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="size-12 sm:size-14 rounded-md overflow-hidden bg-stone-100 dark:bg-stone-800 flex items-center justify-center shrink-0">
          {job.previewUrl ? <img src={job.previewUrl} alt={job.file.name} className="w-full h-full object-cover" /> : <ImageIcon className="size-5 text-stone-400" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm sm:text-base font-medium truncate">{job.file.name}</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">{formatBytes(job.file.size)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {job.status === "queued" && <Badge variant="outline" className="text-stone-500">Queued</Badge>}
          {isProcessing && <Badge variant="outline" className="text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800"><Loader2 className="size-3 mr-1 animate-spin" />Removing...</Badge>}
          {isCompleted && <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800"><CheckCircle2 className="size-3 mr-1" />Done</Badge>}
          {isFailed && <Badge variant="outline" className="text-rose-600 border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800"><XCircle className="size-3 mr-1" />Failed</Badge>}
          <Button variant="ghost" size="icon" className="size-8 text-stone-500 hover:text-stone-700" onClick={onRemove} aria-label="Remove"><XCircle className="size-4" /></Button>
        </div>
      </div>
      {isFailed && (
        <div className="rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900 px-3 py-2 text-xs sm:text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="min-w-0"><p className="font-medium">Background removal failed</p><p className="mt-0.5 break-words">{job.error}</p><Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onRetry}>Retry</Button></div>
        </div>
      )}
      {isCompleted && job.result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <figure className="space-y-1">
              <div className="overflow-hidden rounded border border-stone-200 dark:border-stone-800 bg-[conic-gradient(at_50%_50%,_#e5e5e5_25%,_#f5f5f5_25%_50%,_#e5e5e5_50%_75%,_#f5f5f5_75%)] bg-[length:16px_16px]" style={{ aspectRatio: "1" }}>
                <img src={job.previewUrl} alt={`Original: ${job.file.name}`} className="w-full h-full object-contain" />
              </div>
              <figcaption className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400 text-center">Original</figcaption>
            </figure>
            <figure className="space-y-1">
              <div className="overflow-hidden rounded border border-stone-200 dark:border-stone-800 bg-[conic-gradient(at_50%_50%,_#e5e5e5_25%,_#f5f5f5_25%_50%,_#e5e5e5_50%_75%,_#f5f5f5_75%)] bg-[length:16px_16px]" style={{ aspectRatio: "1" }}>
                <img src={job.result.previewUrl} alt="Background removed" className="w-full h-full object-contain" />
              </div>
              <figcaption className="text-[11px] sm:text-xs text-stone-500 dark:text-stone-400 text-center">Transparent PNG</figcaption>
            </figure>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-stone-500 dark:text-stone-400">{job.result.width}×{job.result.height}px · {formatBytes(job.result.bytes)}</span>
            <Button asChild size="sm" className="gap-2 h-7 text-xs ml-auto"><a href={job.result.downloadUrl} download><Download className="size-3.5" />Download PNG</a></Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PDF PAGE CARD
// ============================================================================
function PdfPageCard({ page }: { page: PdfPageResult }) {
  const [showPreview, setShowPreview] = useState(false);
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-800 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="size-6 rounded bg-stone-100 dark:bg-stone-800 flex items-center justify-center text-[11px] font-medium shrink-0">{page.pageNumber}</span>
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium truncate">Page {page.pageNumber}</p>
            <p className="text-[10px] text-stone-500 dark:text-stone-400">{page.width}×{page.height}px · {formatBytes(page.bytes)}</p>
          </div>
        </div>
        {page.ok ? (
          <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 shrink-0"><CheckCircle2 className="size-3 mr-1" />Done</Badge>
        ) : (
          <Badge variant="outline" className="text-rose-600 border-rose-300 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 shrink-0"><XCircle className="size-3 mr-1" />Failed</Badge>
        )}
      </div>
      {page.ok ? (
        <div className="space-y-2">
          {page.validated && (<div className="flex items-center gap-1.5 text-[10px] text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="size-3" /><span>CMYK validated · 600 DPI</span></div>)}
          {showPreview && page.previewUrl && (
            <div className="overflow-hidden rounded border border-stone-200 dark:border-stone-800 bg-[conic-gradient(at_50%_50%,_#e5e5e5_25%,_#f5f5f5_25%_50%,_#e5e5e5_50%_75%,_#f5f5f5_75%)] bg-[length:16px_16px]" style={{ maxHeight: "300px" }}>
              <img src={page.previewUrl} alt={`Page ${page.pageNumber} preview`} className="w-full h-auto max-h-[300px] object-contain" />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button asChild size="sm" className="gap-1.5 h-7 text-xs"><a href={page.downloadUrl} download><Download className="size-3.5" />Download JPG</a></Button>
            <Button size="sm" variant="ghost" className="gap-1.5 h-7 text-xs" onClick={() => setShowPreview((v) => !v)}><Eye className="size-3.5" />{showPreview ? "Hide" : "Preview"}</Button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-rose-600 dark:text-rose-400">{page.error || "Page processing failed."}</p>
      )}
    </div>
  );
}
