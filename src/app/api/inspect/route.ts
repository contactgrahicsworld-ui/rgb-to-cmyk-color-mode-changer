import { NextRequest, NextResponse } from "next/server";
import { inspectRgbToCmyk } from "@/lib/imaging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const r = Number(body.r);
  const g = Number(body.g);
  const b = Number(body.b);

  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
    return NextResponse.json(
      { ok: false, error: "R, G, B must each be a number 0–255." },
      { status: 400 }
    );
  }

  const result = inspectRgbToCmyk(r, g, b);
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const r = Number(url.searchParams.get("r") ?? 0);
  const g = Number(url.searchParams.get("g") ?? 0);
  const b = Number(url.searchParams.get("b") ?? 0);

  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
    return NextResponse.json(
      { ok: false, error: "R, G, B must each be a number 0–255." },
      { status: 400 }
    );
  }

  const result = inspectRgbToCmyk(r, g, b);
  return NextResponse.json({ ok: true, ...result });
}
