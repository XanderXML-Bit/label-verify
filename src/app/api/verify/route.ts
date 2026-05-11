import { NextResponse } from "next/server";
import { verifyLabel } from "@/lib/verify";
import { DeclaredFieldsSchema } from "@/lib/types";

export const runtime = "nodejs";
// Vercel max for hobby plan is 10s; we run within a 5s vision budget.
export const maxDuration = 60;

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(req: Request) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Body must be multipart/form-data." },
      { status: 400 },
    );
  }

  const file = formData.get("image");
  const declaredRaw = formData.get("declared");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing field 'image' (single file)." },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image exceeds ${MAX_BYTES} bytes. Please compress first.` },
      { status: 413 },
    );
  }
  if (!ACCEPTED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported MIME type "${file.type}". Use JPEG, PNG, or WebP.` },
      { status: 415 },
    );
  }
  if (typeof declaredRaw !== "string") {
    return NextResponse.json(
      { error: "Missing field 'declared' (JSON-encoded DeclaredFields)." },
      { status: 400 },
    );
  }

  let declaredJson: unknown;
  try {
    declaredJson = JSON.parse(declaredRaw);
  } catch {
    return NextResponse.json(
      { error: "Field 'declared' is not valid JSON." },
      { status: 400 },
    );
  }
  const parsed = DeclaredFieldsSchema.safeParse(declaredJson);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Declared fields failed schema validation.",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await verifyLabel(buffer, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    const e = err as Error;
    // Distinguish a vision-API failure from a generic crash so the UI
    // can show the OCR-only graceful-degradation path.
    const aborted = e.name === "AbortError";
    return NextResponse.json(
      {
        error: aborted
          ? "Vision call exceeded the 5 s budget."
          : `Verification failed: ${e.message}`,
        aborted,
      },
      { status: aborted ? 504 : 500 },
    );
  }
}
