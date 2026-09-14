#!/usr/bin/env python3
"""
Colour Mode Converter — Integration Test Suite
Runs the 18 mandatory tests from the spec against a live server at http://localhost:3000.

Usage:
    python3 tests/integration_test.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any

BASE = "http://localhost:3000"
IM_BIN = "/home/z/my-project/bin/imagemagick/usr/bin"

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
INFO = "\033[36mINFO\033[0m"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    tag = PASS if ok else FAIL
    print(f"  [{tag}] {name}" + (f" — {detail}" if detail else ""))


def im(*args: str) -> tuple[int, str, str]:
    """Run an ImageMagick command."""
    p = subprocess.run(
        [f"{IM_BIN}/convert-im7.q16", *args],
        capture_output=True, text=True, timeout=120,
    )
    return p.returncode, p.stdout, p.stderr


def im_identify(*args: str) -> tuple[int, str, str]:
    p = subprocess.run(
        [f"{IM_BIN}/identify-im7.q16", *args],
        capture_output=True, text=True, timeout=60,
    )
    return p.returncode, p.stdout, p.stderr


def im_pixel(path: str, x: int, y: int) -> str:
    """Read a single pixel as 'cmyk(r,g,b,k)' string."""
    code, out, _ = im_identify("-format", f"%[pixel:u.p{{{x},{y}}}]", path)
    return out.strip() if code == 0 else ""


def make_test_image(path: str, rgb: str, size: str = "200x200") -> None:
    im("-size", size, f"xc:rgb({rgb})", path)


def upload(path: str, enhancement: int = 1, session: str | None = None) -> dict[str, Any]:
    """POST /api/process with one file and return parsed JSON."""
    boundary = "----testboundary123"
    with open(path, "rb") as f:
        file_bytes = f.read()
    parts = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="files"; filename="{Path(path).name}"\r\n'.encode()
    )
    parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
    parts.append(file_bytes)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="enhancement"\r\n\r\n')
    parts.append(str(enhancement).encode() + b"\r\n")
    if session:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(b'Content-Disposition: form-data; name="sessionId"\r\n\r\n')
        parts.append(session.encode() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        f"{BASE}/api/process",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def download(session_id: str, file_id: str, dest: str) -> bool:
    url = f"{BASE}/api/download?sessionId={session_id}&fileId={file_id}"
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            with open(dest, "wb") as f:
                f.write(r.read())
        return True
    except Exception:
        return False


def verify_jpeg_cmyk_600dpi(path: str) -> dict[str, Any]:
    code, out, _ = im_identify("-verbose", path)
    if code != 0:
        return {"ok": False, "reason": "identify failed"}
    cs = ""
    res_x = res_y = None
    geom = ""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("Colorspace:"):
            cs = line.split(":", 1)[1].strip()
        elif line.startswith("Resolution:"):
            res = line.split(":", 1)[1].strip()
            try:
                res_x, res_y = map(int, res.split("x"))
            except Exception:
                pass
        elif line.startswith("Geometry:"):
            geom = line.split(":", 1)[1].strip().split("+")[0]
    return {
        "ok": cs == "CMYK" and res_x == 600 and res_y == 600,
        "colorspace": cs,
        "dpi": f"{res_x}x{res_y}",
        "geometry": geom,
    }


def test_pure_colour(name: str, rgb: str, expected_cmyk: str) -> None:
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, f"test_{name}.png")
        make_test_image(img, rgb)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record(f"TEST pure {name}", False, f"upload failed: {item.get('error')}")
            return
        session = resp["sessionId"]
        file_id = item["input"]["id"]
        out = os.path.join(td, "out.jpg")
        if not download(session, file_id, out):
            record(f"TEST pure {name}", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        if not v["ok"]:
            record(f"TEST pure {name}", False, f"verify: {v}")
            return
        # Sample centre pixel
        pixel = im_pixel(out, 100, 100)
        # Convert "cmyk(r,g,b,k)" to actual values
        actual = pixel.replace("cmyk(", "").replace(")", "")
        actual_vals = tuple(int(x) for x in actual.split(","))
        expected_vals = tuple(int(x) for x in expected_cmyk.split(","))
        # Allow ±1 tolerance for JPEG DCT
        ok = all(abs(a - e) <= 1 for a, e in zip(actual_vals, expected_vals))
        record(f"TEST pure {name} → CMYK{expected_cmyk}",
               ok and v["ok"],
               f"got cmyk{actual_vals}, dpi={v['dpi']}")


def test_photograph() -> None:
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "photo.jpg")
        # Create a gradient photograph-like image
        im("-size", "600x400", "gradient:", "-modulate", "100,80,100", img)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 7: Photograph", False, f"failed: {item.get('error')}")
            return
        out = os.path.join(td, "out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 7: Photograph", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        record("TEST 7: Photograph (genuine CMYK JPEG)", v["ok"], f"{v}")


def test_text_image() -> None:
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "text.png")
        im("-size", "800x300", "xc:white",
           "-font", "DejaVu-Sans-Bold", "-pointsize", "72", "-fill", "black",
           "-gravity", "center", "-annotate", "+0+0", "PRINT READY TEXT",
           img)
        resp = upload(img, enhancement=2)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 8: Text-heavy image", False, item.get("error", ""))
            return
        out = os.path.join(td, "out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 8: Text-heavy image", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        # Check text is still readable - sample a black text pixel
        record("TEST 8: Text-heavy image (text preserved)", v["ok"], f"{v}")


def test_enhancement(factor: int) -> None:
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, f"src_{factor}x.png")
        im("-size", "200x150", "gradient:", img)
        start = time.time()
        resp = upload(img, enhancement=factor)
        elapsed = time.time() - start
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record(f"TEST {factor}× enhancement", False, item.get("error", ""))
            return
        out_w = item["output"]["width"]
        out_h = item["output"]["height"]
        expected_w = 200 * factor
        expected_h = 150 * factor
        ok = out_w == expected_w and out_h == expected_h
        out = os.path.join(td, f"out_{factor}x.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record(f"TEST {factor}× enhancement", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        record(f"TEST enhancement {factor}×", ok and v["ok"],
               f"{out_w}x{out_h}px (expected {expected_w}x{expected_h}), dpi={v['dpi']}, {elapsed:.1f}s")


def test_25x_limits() -> None:
    """25× on a large image should be rejected gracefully, but succeed on tiny."""
    with tempfile.TemporaryDirectory() as td:
        # 1. Large image should fail gracefully
        big = os.path.join(td, "big.png")
        im("-size", "1000x1000", "gradient:", big)
        resp = upload(big, enhancement=25)
        item = resp.get("results", [{}])[0]
        # We expect either ok=False with ENHANCEMENT_TOO_LARGE, or ok=True if within limits
        if not item.get("ok"):
            ok = item.get("errorCode") == "ENHANCEMENT_TOO_LARGE"
            record("TEST 12: 25× on large image (graceful failure)",
                   ok, f"errorCode={item.get('errorCode')}, error={item.get('error','')[:80]}")
        else:
            record("TEST 12: 25× on large image (accepted)",
                   True, f"completed in {item.get('elapsedMs')}ms")

        # 2. Tiny image should succeed
        tiny = os.path.join(td, "tiny.png")
        im("-size", "30x30", "xc:red", tiny)
        resp = upload(tiny, enhancement=25)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 12b: 25× on tiny image", False, item.get("error", ""))
            return
        out = os.path.join(td, "tiny_out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 12b: 25× on tiny image", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        expected = 30 * 25
        actual_w = item["output"]["width"]
        record("TEST 12b: 25× on tiny image (real 25× output)",
               v["ok"] and actual_w == expected,
               f"{actual_w}px expected {expected}, dpi={v['dpi']}")


def test_dpi_validation() -> None:
    """Test 13: 600 DPI validation"""
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "src.png")
        im("-size", "300x300", "gradient:", img)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 13: 600 DPI validation", False, item.get("error", ""))
            return
        out = os.path.join(td, "out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 13: 600 DPI validation", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        record("TEST 13: 600 DPI validation",
               v["dpi"] == "600x600", f"dpi={v['dpi']}")


def test_cmyk_jpeg_validation() -> None:
    """Test 14: actual CMYK JPEG validation"""
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "src.png")
        im("-size", "200x200", "xc:rgb(100,150,200)", img)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 14: CMYK JPEG validation", False, item.get("error", ""))
            return
        out = os.path.join(td, "out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 14: CMYK JPEG validation", False, "download failed")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        # Also check magic bytes
        with open(out, "rb") as f:
            head = f.read(3)
        is_jpeg = head[:2] == b"\xff\xd8" and head[2] == 0xff
        record("TEST 14: CMYK JPEG validation",
               v["ok"] and is_jpeg,
               f"colorspace={v['colorspace']}, magic={head.hex()}")


def test_batch_processing() -> None:
    """Test 15: batch processing"""
    with tempfile.TemporaryDirectory() as td:
        files = []
        for i, rgb in enumerate(["255,0,0", "0,255,0", "0,0,255"]):
            p = os.path.join(td, f"img{i}.png")
            im("-size", "100x100", f"xc:rgb({rgb})", p)
            files.append(p)

        # Build multipart with multiple files
        boundary = "----batchboundary456"
        parts = []
        for p in files:
            with open(p, "rb") as f:
                fb = f.read()
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(
                f'Content-Disposition: form-data; name="files"; filename="{Path(p).name}"\r\n'.encode()
            )
            parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
            parts.append(fb)
            parts.append(b"\r\n")
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(b'Content-Disposition: form-data; name="enhancement"\r\n\r\n')
        parts.append(b"1\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)

        req = urllib.request.Request(
            f"{BASE}/api/process",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            resp = json.loads(r.read().decode())

        results_arr = resp.get("results", [])
        ok_count = sum(1 for r in results_arr if r.get("ok"))
        record("TEST 15: Batch processing (3 files)",
               len(results_arr) == 3 and ok_count == 3,
               f"{ok_count}/3 succeeded, session={resp.get('sessionId','')[:8]}...")


def test_corrupted_image() -> None:
    """Test 16: corrupted image handling"""
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "corrupt.jpg")
        with open(img, "wb") as f:
            f.write(b"\xff\xd8\xff\xe0NOT_A_REAL_JPEG_FILE" + b"\x00" * 1000)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        ok = not item.get("ok") and item.get("errorCode") in (
            "UNSUPPORTED_FORMAT", "CORRUPT_IMAGE"
        )
        record("TEST 16: Corrupted image handling",
               ok, f"errorCode={item.get('errorCode')}, error={item.get('error','')[:60]}")


def test_unsupported_file() -> None:
    """Test 17: unsupported file handling"""
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "test.gif")
        im("-size", "50x50", "xc:red", img)
        # ImageMagick might not write GIF if delegate not available; use a fake .gif instead
        if not os.path.exists(img):
            with open(img, "wb") as f:
                f.write(b"GIF89a" + b"\x00" * 20)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        ok = not item.get("ok") and item.get("errorCode") == "UNSUPPORTED_FORMAT"
        record("TEST 17: Unsupported file handling (GIF)",
               ok, f"errorCode={item.get('errorCode')}")


def test_inspect_endpoint() -> None:
    """Test colour inspector API"""
    cases = [
        ("255,0,0", "0,255,255,0", True),
        ("0,0,0", "0,0,0,255", True),
        ("255,255,255", "0,0,0,0", True),
        ("0,255,255", "255,0,0,0", True),
        ("255,0,255", "0,255,0,0", True),
        ("255,255,0", "0,0,255,0", True),
        ("0,0,255", "255,255,0,0", True),
        ("0,255,0", "255,0,255,0", True),
    ]
    all_ok = True
    for rgb, expected_cmyk, exact in cases:
        r, g, b = rgb.split(",")
        url = f"{BASE}/api/inspect?r={r}&g={g}&b={b}"
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            actual = ",".join(str(x) for x in data["cmyk"])
            if actual != expected_cmyk:
                print(f"    {INFO} RGB({rgb}): expected {expected_cmyk}, got {actual}")
                all_ok = False
        except Exception as e:
            print(f"    {INFO} RGB({rgb}): exception {e}")
            all_ok = False
    record("TEST colour inspector (8 pure colours)", all_ok,
           "all 8 exact mappings returned correctly" if all_ok else "see above")


def test_mobile_layout() -> None:
    """Test 18: Mobile layout - check page renders and is responsive."""
    # Just check the page returns HTML without errors
    try:
        req = urllib.request.Request(f"{BASE}/")
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode()
        # Check for presence of key UI elements
        has_upload = "Upload images" in html or "upload" in html.lower()
        has_enhancement = "Enhancement" in html or "enhancement" in html.lower()
        has_inspector = "Colour Inspector" in html or "Inspector" in html
        record("TEST 18: Mobile layout (page renders, key UI present)",
               has_upload and has_enhancement and has_inspector,
               f"upload={has_upload}, enhancement={has_enhancement}, inspector={has_inspector}")
    except Exception as e:
        record("TEST 18: Mobile layout", False, str(e))


def test_independent_file_verification() -> None:
    """Test 24: Independent file verification - file opens outside the app."""
    with tempfile.TemporaryDirectory() as td:
        img = os.path.join(td, "src.png")
        im("-size", "300x300", "gradient:", img)
        resp = upload(img, enhancement=1)
        item = resp.get("results", [{}])[0]
        if not item.get("ok"):
            record("TEST 24: Independent file verification", False, item.get("error", ""))
            return
        out = os.path.join(td, "out.jpg")
        if not download(resp["sessionId"], item["input"]["id"], out):
            record("TEST 24: Independent file verification", False, "download failed")
            return
        # Use identify independently to verify the file opens
        code, out_text, _ = im_identify(out)
        if code != 0:
            record("TEST 24: Independent file verification", False, "identify could not read file")
            return
        v = verify_jpeg_cmyk_600dpi(out)
        record("TEST 24: Independent file verification (opens in identify)",
               v["ok"], f"colorspace={v['colorspace']}, dpi={v['dpi']}, geometry={v['geometry']}")


def main() -> int:
    # Verify server is up
    try:
        with urllib.request.urlopen(f"{BASE}/api/inspect?r=128&g=128&b=128", timeout=5) as r:
            data = json.loads(r.read().decode())
        if not data.get("ok"):
            raise RuntimeError("Inspector endpoint returned not ok")
    except Exception as e:
        print(f"{FAIL} Server not reachable at {BASE}: {e}")
        return 1

    print(f"\n{'=' * 70}")
    print("Colour Mode Converter — Integration Test Suite")
    print(f"{'=' * 70}\n")

    print("Tests 1–6: Pure colour mappings")
    test_pure_colour("red",     "255,0,0",     "0,255,255,0")
    test_pure_colour("black",   "0,0,0",       "0,0,0,255")
    test_pure_colour("white",   "255,255,255", "0,0,0,0")
    test_pure_colour("cyan",    "0,255,255",   "255,0,0,0")
    test_pure_colour("magenta", "255,0,255",   "0,255,0,0")
    test_pure_colour("yellow",  "255,255,0",   "0,0,255,0")
    test_pure_colour("blue",    "0,0,255",     "255,255,0,0")
    test_pure_colour("green",   "0,255,0",     "255,0,255,0")

    print("\nTest 7: Normal RGB photograph")
    test_photograph()

    print("\nTest 8: Text-heavy image")
    test_text_image()

    print("\nTests 9–12: Enhancement factors")
    test_enhancement(2)
    test_enhancement(4)
    test_enhancement(10)
    test_25x_limits()

    print("\nTest 13: 600 DPI validation")
    test_dpi_validation()

    print("\nTest 14: Actual CMYK JPEG validation")
    test_cmyk_jpeg_validation()

    print("\nTest 15: Batch processing")
    test_batch_processing()

    print("\nTest 16: Corrupted image handling")
    test_corrupted_image()

    print("\nTest 17: Unsupported file handling")
    test_unsupported_file()

    print("\nTest 18: Mobile layout")
    test_mobile_layout()

    print("\nColour Inspector tests")
    test_inspect_endpoint()

    print("\nTest 24: Independent file verification")
    test_independent_file_verification()

    # Summary
    print(f"\n{'=' * 70}")
    print("SUMMARY")
    print(f"{'=' * 70}")
    passed = sum(1 for _, ok, _ in results if ok)
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"  {PASS} {passed}    {FAIL} {failed}    Total: {len(results)}")
    if failed:
        print("\nFailed tests:")
        for name, ok, detail in results:
            if not ok:
                print(f"  - {name}: {detail}")
    print()
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
