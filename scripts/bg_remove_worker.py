#!/usr/bin/env python3
"""Background Remove Worker - HTTP server that spawns subprocess per request."""
from __future__ import annotations
import os, sys, json, subprocess, tempfile, traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

_HEALTH_READY = True
_SUBPROCESS_SCRIPT = '''
import sys, os, gc
sys.stderr.write("[worker-sub] Loading model...\\n"); sys.stderr.flush()
from rembg import remove, new_session
from PIL import Image
session = new_session("u2netp")
sys.stderr.write("[worker-sub] Model loaded\\n"); sys.stderr.flush()
inp = Image.open(sys.argv[1])
if inp.mode == "P": inp = inp.convert("RGBA")
elif inp.mode == "LA": inp = inp.convert("RGBA")
elif inp.mode in ("L", "1"): inp = inp.convert("RGB")
elif inp.mode == "CMYK": inp = inp.convert("RGB")
elif inp.mode not in ("RGB", "RGBA"): inp = inp.convert("RGB")
orig_w, orig_h = inp.size
MAX_INPUT_DIM = 5000
if max(orig_w, orig_h) > MAX_INPUT_DIM:
    if orig_w >= orig_h: new_w, new_h = MAX_INPUT_DIM, int(orig_h * (MAX_INPUT_DIM / orig_w))
    else: new_h, new_w = MAX_INPUT_DIM, int(orig_w * (MAX_INPUT_DIM / orig_h))
    inp = inp.resize((new_w, new_h), Image.LANCZOS); orig_w, orig_h = inp.size
MAX_PROCESS_MP = 600_000; orig_mp = orig_w * orig_h
if orig_mp > MAX_PROCESS_MP:
    scale = (MAX_PROCESS_MP / orig_mp) ** 0.5
    process_w, process_h = max(1, int(orig_w * scale)), max(1, int(orig_h * scale))
    full_rgb = inp.convert("RGB") if inp.mode != "RGB" else inp.copy()
    del inp; gc.collect()
    inp_to_process = full_rgb.resize((process_w, process_h), Image.LANCZOS)
    downscaled = True
else:
    inp_to_process = inp; full_rgb = None; downscaled = False
out_small = remove(inp_to_process, session=session)
if downscaled:
    out = out_small.resize((orig_w, orig_h), Image.LANCZOS)
    if out.mode == "RGBA" and full_rgb is not None:
        alpha = out.split()[3]
        out = Image.merge("RGBA", (*full_rgb.split()[:3], alpha))
else:
    out = out_small
if out.size != (orig_w, orig_h):
    out = out.resize((orig_w, orig_h), Image.LANCZOS)
out.save(sys.argv[2], format="PNG", optimize=True)
print(f"OK {orig_w} {orig_h} {out.size[0]} {out.size[1]}")
'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[bg-remove] {self.command} {self.path}\n"); sys.stderr.flush()
    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def _send_bytes(self, code, content_type, body, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items(): self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "ready": _HEALTH_READY})
        else:
            self._send_json(404, {"ok": False, "error": "Not found"})
    def do_POST(self):
        if self.path != "/remove":
            self._send_json(404, {"ok": False, "error": "Not found"}); return
        ct = self.headers.get("Content-Type", "")
        if not ct.startswith("multipart/form-data"):
            self._send_json(400, {"ok": False, "error": "Expected multipart/form-data"}); return
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0: self._send_json(400, {"ok": False, "error": "Empty body"}); return
            if content_length > 50 * 1024 * 1024: self._send_json(413, {"ok": False, "error": "File too large"}); return
            body = self.rfile.read(content_length)
            file_bytes, file_name = self._parse_multipart(body, ct)
            if file_bytes is None: self._send_json(400, {"ok": False, "error": "No file field"}); return
            if not _is_valid_image(file_bytes): self._send_json(400, {"ok": False, "error": "Unsupported format"}); return
            with tempfile.NamedTemporaryFile(suffix=".in", delete=False) as f:
                f.write(file_bytes); input_path = f.name
            output_path = input_path + ".out.png"
            try:
                result = subprocess.run([sys.executable, "-c", _SUBPROCESS_SCRIPT, input_path, output_path], capture_output=True, text=True, timeout=240)
                if result.returncode != 0:
                    self._send_json(500, {"ok": False, "error": f"Processing failed: {result.stderr[-200:]}"}); return
                with open(output_path, "rb") as f: png_bytes = f.read()
                stdout_line = result.stdout.strip().split("\n")[-1] if result.stdout else ""
                parts = stdout_line.split()
                if len(parts) >= 5 and parts[0] == "OK":
                    orig_w, orig_h, out_w, out_h = int(parts[1]), int(parts[2]), int(parts[3]), int(parts[4])
                else: orig_w = orig_h = out_w = out_h = 0
                base_name = os.path.splitext(os.path.basename(file_name or "image"))[0]
                safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in base_name)[:60] or "image"
                self._send_bytes(200, "image/png", png_bytes, {
                    "Content-Disposition": f'attachment; filename="{safe_name}_transparent.png"',
                    "X-Original-Width": str(orig_w), "X-Original-Height": str(orig_h),
                    "X-Output-Width": str(out_w), "X-Output-Height": str(out_h),
                    "X-Output-Format": "PNG", "X-Output-Alpha": "true",
                    "Cache-Control": "private, no-store",
                })
            finally:
                try: os.unlink(input_path)
                except: pass
                try: os.unlink(output_path)
                except: pass
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": "Processing timed out"})
        except Exception as e:
            sys.stderr.write(f"[bg-remove] Error: {e}\n{traceback.format_exc()}\n"); sys.stderr.flush()
            self._send_json(500, {"ok": False, "error": f"Processing failed: {str(e)[:200]}"})
    def _parse_multipart(self, body, content_type):
        boundary_match = content_type.split("boundary=")
        if len(boundary_match) < 2: return None, None
        boundary = boundary_match[1].strip()
        if boundary.startswith('"') and boundary.endswith('"'): boundary = boundary[1:-1]
        parts = body.split(("--" + boundary).encode())
        for part in parts:
            if not part or part == b"--" or part == b"--\r\n" or part == b"\r\n": continue
            if part.startswith(b"\r\n"): part = part[2:]
            if part.endswith(b"\r\n"): part = part[:-2]
            if b"\r\n\r\n" not in part: continue
            header_block, content = part.split(b"\r\n\r\n", 1)
            if content.endswith(b"\r\n"): content = content[:-2]
            headers = header_block.decode("utf-8", errors="replace")
            if 'filename="' in headers:
                fn_start = headers.index('filename="') + 10; fn_end = headers.index('"', fn_start)
                return content, headers[fn_start:fn_end]
        return None, None

def _is_valid_image(buf):
    if len(buf) < 12: return False
    if buf[:3] == b"\xff\xd8\xff": return True
    if buf[:8] == b"\x89PNG\r\n\x1a\n": return True
    if buf[:4] == b"RIFF" and buf[8:12] == b"WEBP": return True
    if buf[:2] == b"BM": return True
    if buf[:6] in (b"GIF87a", b"GIF89a"): return True
    return False

def main():
    port = int(os.environ.get("BG_REMOVE_PORT", "3030"))
    sys.stderr.write(f"[bg-remove] Starting server on port {port} (subprocess mode)\n"); sys.stderr.flush()
    server = HTTPServer(("0.0.0.0", port), Handler)
    server.timeout = None; server.request_queue_size = 5
    try: server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("[bg-remove] Shutting down\n"); server.shutdown()

if __name__ == "__main__":
    main()
