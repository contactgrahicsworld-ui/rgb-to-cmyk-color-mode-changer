#!/usr/bin/env python3
"""Single-shot background removal script."""
import sys, os, gc

def main():
    if len(sys.argv) != 3:
        print("Usage: bg_remove_one.py <input> <output>", file=sys.stderr)
        sys.exit(2)
    input_path, output_path = sys.argv[1], sys.argv[2]
    if not os.path.exists(input_path):
        print(f"Input not found: {input_path}", file=sys.stderr)
        sys.exit(2)
    sys.stderr.write("[bg-one] Loading model...\n"); sys.stderr.flush()
    from rembg import remove, new_session
    from PIL import Image
    session = new_session("u2netp")
    sys.stderr.write("[bg-one] Model loaded\n"); sys.stderr.flush()
    inp = Image.open(input_path)
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
    out.save(output_path, format="PNG", optimize=True)
    print(f"OK {orig_w} {orig_h} {out.size[0]} {out.size[1]}")
    sys.exit(0)

if __name__ == "__main__":
    main()
