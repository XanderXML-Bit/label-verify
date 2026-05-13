"use client";

import { useEffect, useState } from "react";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";
import type { ExtractOnlyResponse } from "@/lib/verify";
import { UploadZone } from "./components/UploadZone";
import { DeclaredForm } from "./components/DeclaredForm";
import { SingleResult } from "./components/SingleResult";
import { ExtractionOnlyResult } from "./components/ExtractionOnlyResult";
import { VerifyProgress } from "./components/VerifyProgress";
import { ApiStatusBanner } from "./components/ApiStatusBanner";
import { BatchView, type BatchRow } from "./components/BatchView";
import { BatchProgress, type BatchPhase } from "./components/BatchProgress";
import { SampleAffordance } from "./components/SampleAffordance";
// ReviewQueuePanel intentionally not imported on the idle screen — it
// surfaces a DEBUG_TOKEN access-code prompt to public visitors, which
// is confusing UX for the prototype. Operators with the token can use
// /api/queue directly. User feedback 2026-05-13.
// import { ReviewQueuePanel } from "./components/ReviewQueuePanel";
import {
  ApplicationUpload,
  type ApplicationParsePayload,
} from "./components/ApplicationUpload";
import type { Sample } from "@/lib/samples";
import { compressImageInBrowser } from "@/lib/client-compress";
import { classifyFile } from "@/lib/batch-pairing";
import { mergeFilesForRestage } from "@/lib/upload-merge";

// Minimal HTTP error carrier so the batch XHR pipeline can surface
// status codes to friendlyError() the same way the fetch() path
// did. Not exported — the catch site re-narrows.
class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Translate raw API error strings into plain-language copy a senior
// reviewer can act on. The raw `HTTP 503` / `FUNCTION_INVOCATION_
// TIMEOUT` strings are noise to a non-technical user.
function friendlyError(raw: string, status?: number): string {
  if (status === 429) {
    return "We've hit the per-minute request limit. Wait a moment and try again.";
  }
  if (status === 413) {
    return "That file is too large. Try a smaller upload (under 10 MB) or compress it first.";
  }
  if (status === 415) {
    return "That file type isn't supported. Accepted label images: JPEG, PNG, WebP, HEIC, PDF.";
  }
  if (status === 504 || /timeout|TIMEOUT/.test(raw)) {
    return "The verification took too long to respond. The service may be cold-starting — try again in a few seconds.";
  }
  if (status === 503 || /UNAVAILABLE|configuration/.test(raw)) {
    return "The verification service is unavailable right now. Try again in a few minutes; if it keeps failing, the operator may need to refresh the API key.";
  }
  if (status === 500) {
    return "Something went wrong on our side. Try again — if it keeps happening, take a screenshot and let the team know.";
  }
  // No HTTP status — typically a browser-level fetch failure (offline,
  // DNS, CORS preflight). Match the common TypeError messages and
  // humanise them instead of echoing the raw browser exception. UI
  // audit C-2 (2026-05-12).
  if (status === undefined) {
    if (/failed to fetch|networkerror|net::|load failed/i.test(raw)) {
      return "We couldn't reach the verifier — check your network connection and try again.";
    }
    if (/abort/i.test(raw)) {
      return "The request was cancelled. Try again.";
    }
  }
  return raw;
}

type Stage =
  | { kind: "idle" }
  | { kind: "single-pending"; file: File; previewUrl: string }
  | { kind: "single-verifying"; file: File; previewUrl: string }
  | { kind: "single-extracting"; file: File; previewUrl: string }
  | { kind: "single-done"; file: File; previewUrl: string; result: VerifyResponse }
  | {
      kind: "single-extract-done";
      file: File;
      previewUrl: string;
      result: ExtractOnlyResponse;
    }
  | {
      kind: "single-error";
      file: File;
      previewUrl: string;
      message: string;
      /** Override the default "Verification failed" heading — used for
       *  pre-flight rejections (e.g. "Label image required") where no
       *  verification was attempted. UI audit C-4. */
      title?: string;
      /** Set when the failed flow originated from a sample button — lets
       *  the UI offer a "retry this sample" affordance instead of the
       *  generic "Try again" that just dumps the user back to idle. */
      retrySample?: Sample;
    }
  | {
      kind: "batch-pending";
      files: File[];
      /** True when the drop included at least one application file
       *  (PDF/JSON/CSV/MD/TXT/DOCX) — the server's auto-pair path
       *  handles these directly, so the UI skips the manifest-paste
       *  screen and shows a "ready to verify" summary instead. */
      autoPair: boolean;
      submitError?: string;
    }
  | { kind: "batch-running"; batchId: string; rows: BatchRow[] };

export default function Home() {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [manifestText, setManifestText] = useState("");
  // Parsed application payload, used to prefill DeclaredForm. The
  // monotonic `version` counter is appended to the form key so the
  // controlled inputs re-initialise when a new file lands.
  const [appPrefill, setAppPrefill] = useState<{
    fields: ApplicationParsePayload["fields"];
    source: ApplicationParsePayload["source"];
    filename: string;
    version: number;
  } | null>(null);

  // Background-parse status for the unified drop flow. When the user
  // drops an image + an application file together, parseAppInBackground
  // fires the parse asynchronously; the form opens immediately so the
  // user can start filling manually if they prefer. This state lets us
  // surface a "Parsing <filename>…" indicator next to the form so the
  // user knows the fields will populate in a moment.
  const [bgAppParse, setBgAppParse] = useState<
    | { kind: "idle" }
    | { kind: "parsing"; filename: string }
    | { kind: "failed"; filename: string }
  >({ kind: "idle" });
  // Names of extra application files the user dropped that we ignored
  // (1 image + N apps where N > 1 — we keep the stem-matched one and
  // drop the rest). UI audit blocker #2: previously this only went to
  // console.warn; now we surface it visibly next to the form so the
  // reviewer knows their second file wasn't silently lost.
  const [ignoredApps, setIgnoredApps] = useState<readonly string[]>([]);

  // Warm the function + Tesseract worker on page load (DEPLOYMENT.md §6).
  // The AbortController prevents stacked warmups across the
  // mount→unmount→remount lifecycle (e.g. fast tab close/reopen, React
  // StrictMode double-invoke in dev) — without it each remount fires a
  // fresh warmup that the previous mount can no longer act on. UX audit P-7.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/warmup", { signal: ac.signal }).catch(() => undefined);
    return () => ac.abort();
  }, []);

  // While async work is in flight, mutate document.title so a reviewer
  // who tabs away to email can see "(Verifying…) Label Verify" in the
  // tab strip and know when to switch back. UX audit P-8. Restored on
  // unmount and on any state transition that lands on idle/done/error.
  useEffect(() => {
    const baseTitle = "Label Verify";
    // batch-running stays as the stage even after the inline-batch
    // POST returns terminal rows (all done/error). In that case we're
    // not actually verifying anymore — the title should revert to
    // baseTitle so the tab strip doesn't lie. Detect "all rows
    // terminal" inside the batch-running stage.
    const batchActive =
      stage.kind === "batch-running" &&
      stage.rows.some(
        (r) => r.status === "pending" || r.status === "running",
      );
    const isBusy =
      stage.kind === "single-verifying" ||
      stage.kind === "single-extracting" ||
      batchActive;
    document.title = isBusy ? `(Verifying…) ${baseTitle}` : baseTitle;
    return () => {
      document.title = baseTitle;
    };
    // Depend on the entire stage so the title re-evaluates when
    // stage.rows transitions terminal — for the inline-batch path
    // both the kind AND the rows land in one setStage call but the
    // batchActive predicate above keys on rows, so we need rows in
    // the dep array.
  }, [stage]);

  function revokeIfPreview(s: Stage): void {
    if (
      s.kind === "single-pending" ||
      s.kind === "single-verifying" ||
      s.kind === "single-extracting" ||
      s.kind === "single-done" ||
      s.kind === "single-extract-done" ||
      s.kind === "single-error"
    ) {
      try {
        URL.revokeObjectURL(s.previewUrl);
      } catch {
        // ignore
      }
    }
  }

  function handleFiles(files: File[]) {
    revokeIfPreview(stage);
    if (files.length === 0) return;

    // Intent inference: classify dropped files into images vs
    // application documents (PDF / JSON / CSV / MD / TXT) and branch.
    // Per UX recommendation 2026-05-12: a single dropzone that handles
    // (1 image, 1 image + 1 application, N images, N images + N apps)
    // without making the reviewer hunt for the right input slot.
    const images: File[] = [];
    const apps: File[] = [];
    const ignored: File[] = [];
    for (const f of files) {
      const kind = classifyFile(f);
      if (kind === "image") images.push(f);
      else if (kind === "application") apps.push(f);
      else ignored.push(f);
    }

    // Zero images: can't verify anything.
    if (images.length === 0) {
      // No safe way to enter a meaningful stage. Surface a transient
      // alert via a single-error stage so the user sees a clear
      // message, then returns to idle on dismiss.
      setStage({
        kind: "single-error",
        // Synthesize a placeholder file/preview so the existing error
        // stage shape is satisfied; reset() clears it.
        file: apps[0] ?? new File([], "missing.txt"),
        previewUrl: "",
        title: "Label image required",
        message:
          "Please include at least one label image (JPEG, PNG, WebP, HEIC, or PDF). " +
          (apps.length
            ? "An application file was detected but a label image is required for verification."
            : "Unsupported file types were detected — drop a label image instead."),
      });
      return;
    }

    // One image: single-pending. If exactly one application file
    // came along, kick off a background parse so the form pre-fills
    // by the time the reviewer looks at it.
    if (images.length === 1) {
      const img = images[0]!;
      const url = URL.createObjectURL(img);
      setStage({ kind: "single-pending", file: img, previewUrl: url });

      if (apps.length >= 1) {
        // If multiple apps, prefer the one whose stem matches the
        // image; else just take the first.
        const matched =
          apps.find((a) => stemMatches(a.name, img.name)) ?? apps[0]!;
        // Pass the image filename so the parser can pick the matching
        // row out of a multi-row manifest (filename-keyed JSON object,
        // `filename`-column CSV). Without this context, a 12-row
        // manifest dropped alongside one image would parse as the
        // whole manifest flattened into garbage column names.
        void parseAppInBackground(matched, img.name);
        if (apps.length > 1) {
          // Surface the discarded apps to BOTH the developer console
          // (full provenance) AND the form UI (so the reviewer sees
          // that their second file wasn't silently dropped). UI audit
          // blocker #2.
          const ignoredNames = apps
            .filter((a) => a !== matched)
            .map((a) => a.name);
          setIgnoredApps(ignoredNames);
          console.warn(
            `[upload] ${apps.length} application files dropped with 1 image; using "${matched.name}". Ignored: ${ignoredNames.join(", ")}`,
          );
        } else {
          setIgnoredApps([]);
        }
      } else {
        setIgnoredApps([]);
      }
      if (ignored.length > 0) {
        console.warn(
          `[upload] ignored ${ignored.length} unsupported file(s): ${ignored.map((f) => f.name).join(", ")}`,
        );
      }
      return;
    }

    // Multiple images: batch mode. If application files came along,
    // the server's auto-pair path handles them — the user never sees
    // the manifest paste screen. If only images were dropped, fall
    // back to the manifest paste screen so the user can supply
    // declared fields for each.
    setStage({
      kind: "batch-pending",
      files: [...images, ...apps],
      autoPair: apps.length > 0,
    });
  }

  /**
   * Incremental, additive file staging.
   *
   * Why: iOS Safari's file picker often returns only a single Photo
   * even when `<input multiple>` is set. If we replace the staged
   * set on every picker callback (as the default UploadZone does
   * from the idle screen), an iPhone user who needs to assemble a
   * 5-photo batch ends up with only their last selection. This
   * helper merges the new selection with whatever's already staged
   * — preserving order and de-duping by (name, size, lastModified)
   * — and re-routes through `handleFiles` so the same intent-
   * inference logic decides which stage to land in.
   *
   * Called by the "Add more files" UploadZone rendered underneath
   * the single-pending image preview and the batch-pending autoPair
   * "Detected" summary. Desktop users are unaffected: the original
   * idle-screen dropzone still uses replace semantics, so
   * drag-and-drop-5-files-at-once works identically.
   */
  function handleAdditionalFiles(newFiles: File[]) {
    if (newFiles.length === 0) return;
    const existing: File[] =
      stage.kind === "single-pending"
        ? [stage.file]
        : stage.kind === "batch-pending"
          ? stage.files
          : [];
    const merged = mergeFilesForRestage(existing, newFiles);
    handleFiles(merged);
  }

  /** Parse an application file via /api/application/parse and feed the
   *  result into the existing pre-fill state. Surfaces a `bgAppParse`
   *  status the form panel can render as a "Parsing …" pill so the
   *  user knows fields will land in a moment. Failures degrade
   *  silently — the reviewer can still fill the form manually.
   *
   *  When `imageFilename` is supplied (single-image flow with a
   *  multi-row manifest, batch flow), the route can pick the row
   *  matching that filename out of a filename-keyed or `filename`-
   *  column manifest instead of treating the whole file as a single
   *  record. */
  async function parseAppInBackground(file: File, imageFilename?: string) {
    setBgAppParse({ kind: "parsing", filename: file.name });
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (imageFilename) fd.append("imageFilename", imageFilename);
      const res = await fetch("/api/application/parse", { method: "POST", body: fd });
      if (!res.ok) {
        setBgAppParse({ kind: "failed", filename: file.name });
        return;
      }
      const body = (await res.json()) as ApplicationParsePayload & {
        fields?: Partial<DeclaredFields>;
      };
      if (body.fields) {
        handleApplicationParsed({
          fields: body.fields,
          source: body.source,
          filename: file.name,
          warnings: body.warnings ?? [],
          confidence: body.confidence,
        });
        setBgAppParse({ kind: "idle" });
      } else {
        setBgAppParse({ kind: "failed", filename: file.name });
      }
    } catch {
      setBgAppParse({ kind: "failed", filename: file.name });
    }
  }

  /** True if two filenames share the same stem (case-insensitive). */
  function stemMatches(a: string, b: string): boolean {
    const stem = (s: string) => {
      const base = s.split(/[\\/]/).pop() ?? s;
      const dot = base.lastIndexOf(".");
      return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
    };
    return stem(a) === stem(b);
  }

  async function handleSample(sample: Sample, file: File) {
    // Sample affordance: skip the form and verify immediately so the
    // reviewer sees an end-to-end result in one click (UI-SPEC.md §4).
    revokeIfPreview(stage);
    const url = URL.createObjectURL(file);
    setStage({ kind: "single-verifying", file, previewUrl: url });
    try {
      const uploadFile = await compressImageInBrowser(file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      fd.append("declared", JSON.stringify(sample.declared));
      const res = await fetch("/api/verify", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file,
          previewUrl: url,
          message: friendlyError(err.error ?? `HTTP ${res.status}`, res.status),
          retrySample: sample,
        });
        return;
      }
      const result = (await res.json()) as VerifyResponse;
      setStage({ kind: "single-done", file, previewUrl: url, result });
    } catch (e) {
      setStage({
        kind: "single-error",
        file,
        previewUrl: url,
        retrySample: sample,
        message: friendlyError((e as Error).message),
      });
    }
  }

  async function submitSingle(declared: DeclaredFields) {
    if (stage.kind !== "single-pending") return;
    setStage({ ...stage, kind: "single-verifying" });
    try {
      // Compress in the browser before upload. Cuts a 4–8 MB phone photo
      // to ~250–500 KB and shaves multi-second uploads on cellular.
      const uploadFile = await compressImageInBrowser(stage.file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      fd.append("declared", JSON.stringify(declared));
      const res = await fetch("/api/verify", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file: stage.file,
          previewUrl: stage.previewUrl,
          message: friendlyError(err.error ?? `HTTP ${res.status}`, res.status),
        });
        return;
      }
      const result = (await res.json()) as VerifyResponse;
      setStage({
        kind: "single-done",
        file: stage.file,
        previewUrl: stage.previewUrl,
        result,
      });
    } catch (e) {
      setStage({
        kind: "single-error",
        file: stage.file,
        previewUrl: stage.previewUrl,
        message: friendlyError((e as Error).message),
      });
    }
  }

  async function submitExtractOnly() {
    if (stage.kind !== "single-pending") return;
    setStage({ ...stage, kind: "single-extracting" });
    try {
      const uploadFile = await compressImageInBrowser(stage.file);
      const fd = new FormData();
      fd.append("image", uploadFile);
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setStage({
          kind: "single-error",
          file: stage.file,
          previewUrl: stage.previewUrl,
          message: friendlyError(err.error ?? `HTTP ${res.status}`, res.status),
        });
        return;
      }
      const result = (await res.json()) as ExtractOnlyResponse;
      setStage({
        kind: "single-extract-done",
        file: stage.file,
        previewUrl: stage.previewUrl,
        result,
      });
    } catch (e) {
      setStage({
        kind: "single-error",
        file: stage.file,
        previewUrl: stage.previewUrl,
        message: friendlyError((e as Error).message),
      });
    }
  }

  // Tracks whether a batch submission is currently in flight. Bound to
  // the Verify button's disabled state + a "Uploading + pairing..."
  // banner so the reviewer gets immediate visual feedback after click
  // (previously the auto-pair path had no submission indicator until
  // the SSE stream opened, which felt unresponsive on slow networks).
  // Per user feedback 2026-05-13.
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  // filename → blob: URL map built at submit time so the BatchView
  // can show a thumbnail per row and the drilldown panel can render
  // the actual image the operator uploaded. State is cleared (and
  // each URL revoked) when the user leaves the batch-running stage
  // via reset() — see revokeIfPreview-equivalent below.
  const [batchPreviewByFilename, setBatchPreviewByFilename] = useState<
    Record<string, string>
  >({});
  // Determinate-progress state for the batch flow. The bar accounts
  // for the three observable phases (upload, server-side pairing
  // through the four-stage pipeline, per-row verification) and uses
  // real upload bytes from XHR onprogress + estimated time-vs-
  // budget for the server-side phases.
  const [batchPhase, setBatchPhase] = useState<BatchPhase>("idle");
  const [batchUploadFraction, setBatchUploadFraction] = useState<
    number | undefined
  >(undefined);
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  // Re-render ticker for the progress bar's elapsed-time estimate.
  // The interval lives in the BatchProgress component itself, but we
  // also need a way to compute elapsedMs here for the prop.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (batchPhase === "idle") return;
    const id = setInterval(() => setNowTick((t) => t + 1), 200);
    return () => clearInterval(id);
  }, [batchPhase]);

  // The `manifestOverride` parameter exists to dodge a real React state
  // race: `setManifestText("")` schedules an update, but `submitBatch`
  // runs synchronously and closes over the OLD `manifestText`. The
  // auto-pair button passed `setManifestText(""); submitBatch();` and
  // the server received the old (often non-empty) value → hit the
  // explicit-manifest path → returned the user's reported "No valid
  // (image, declared-fields) pairs after manifest parse" error.
  // Pass `""` explicitly to force the auto-pair path.
  async function submitBatch(manifestOverride?: string) {
    if (stage.kind !== "batch-pending") return;
    const manifest = manifestOverride ?? manifestText;
    setBatchSubmitting(true);
    setBatchPhase("uploading");
    setBatchUploadFraction(undefined);
    setBatchStartedAt(Date.now());
    // Build a filename → blob: URL map for the batch view to show
    // per-row thumbnails and per-drilldown image previews. Only IMAGE
    // files (jpg/png/webp/heic) get a preview URL; application files
    // (json/csv/pdf/etc.) are skipped. Each URL is revoked when the
    // user leaves the batch-running stage via reset().
    const previewMap: Record<string, string> = {};
    const imageRe = /\.(jpe?g|png|webp|heic|heif)$/i;
    for (const f of stage.files) {
      if (imageRe.test(f.name)) {
        try {
          previewMap[f.name] = URL.createObjectURL(f);
        } catch {
          // Defensive: createObjectURL on a freshly-uploaded File
          // shouldn't throw in any supported browser, but if it does
          // we just fall back to the placeholder thumbnail.
        }
      }
    }
    setBatchPreviewByFilename(previewMap);
    const fd = new FormData();
    fd.append("manifest", manifest);
    for (const f of stage.files) fd.append(f.name, f);
    // Use XHR rather than fetch so the upload's onprogress is real
    // data (fetch does not surface POST-upload progress in any
    // browser we care about). After upload completes the bar
    // estimates the remaining phases from elapsed time vs the
    // per-image P50 budget — see BatchProgress.
    try {
      const body = await new Promise<{
        batchId: string;
        count: number;
        pairingErrors?: string[];
        inline?: boolean;
        results?: Array<{
          index: number;
          filename: string;
          status: "done" | "error";
          result?: VerifyResponse;
          error?: string;
        }>;
      }>((resolveBody, rejectBody) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/verify/batch");
        xhr.responseType = "json";
        xhr.upload.onprogress = (e: ProgressEvent): void => {
          if (e.lengthComputable && e.total > 0) {
            setBatchUploadFraction(e.loaded / e.total);
          }
        };
        xhr.upload.onload = (): void => {
          // Upload bytes complete → server is now pairing + verifying.
          setBatchUploadFraction(1);
          setBatchPhase("pairing");
          // After ~2 s of pairing budget, switch to "verifying" so the
          // bar label matches reality even though we have no real
          // signal from the server about which phase it's in.
          setTimeout(() => setBatchPhase("verifying"), 2_000);
        };
        xhr.onload = (): void => {
          setBatchPhase("finalising");
          if (xhr.status >= 200 && xhr.status < 300) {
            const parsed =
              typeof xhr.response === "object" && xhr.response !== null
                ? xhr.response
                : JSON.parse(xhr.responseText);
            resolveBody(parsed);
          } else {
            const err =
              (xhr.response && (xhr.response as { error?: string }).error) ??
              `HTTP ${xhr.status}`;
            rejectBody(new HttpError(err, xhr.status));
          }
        };
        xhr.onerror = (): void => {
          rejectBody(new Error("Network error during batch upload."));
        };
        xhr.send(fd);
      });
      if (body.inline && body.results) {
        // Inline batch — render results immediately.
        const rows: BatchRow[] = body.results.map((r) =>
          r.status === "done" && r.result
            ? {
                index: r.index,
                filename: r.filename,
                status: "done" as const,
                result: r.result,
              }
            : {
                index: r.index,
                filename: r.filename,
                status: "error" as const,
                error: r.error ?? "Verification failed",
              },
        );
        setStage({ kind: "batch-running", batchId: body.batchId, rows });
      } else {
        // Legacy SSE path (back-compat for local single-process dev).
        const rows: BatchRow[] = Array.from({ length: body.count }, (_, i) => ({
          index: i,
          filename: stage.files[i]?.name ?? `item-${i}`,
          status: "pending" as const,
        }));
        setStage({ kind: "batch-running", batchId: body.batchId, rows });
      }
      setBatchSubmitting(false);
      setBatchPhase("idle");
    } catch (e) {
      const httpStatus = e instanceof HttpError ? e.status : undefined;
      setStage({
        kind: "batch-pending",
        files: stage.files,
        autoPair: stage.autoPair,
        submitError: friendlyError((e as Error).message, httpStatus),
      });
      setBatchSubmitting(false);
      setBatchPhase("idle");
    }
  }

  // ExtractionOnly → continue-to-verify. Pre-fills DeclaredForm with the
  // values the extractor read off the label, so the user can edit and
  // submit against /api/verify without re-uploading the image.
  function continueToVerification() {
    if (stage.kind !== "single-extract-done") return;
    const e = stage.result.extracted;
    const fields: Partial<DeclaredFields> = {
      brand_name: typeof e.brand_name.value === "string" ? e.brand_name.value : undefined,
      class_type: typeof e.class_type.value === "string" ? e.class_type.value : undefined,
      abv_percent: typeof e.abv_percent.value === "number" ? e.abv_percent.value : undefined,
      net_contents:
        e.net_contents.value && typeof e.net_contents.value === "object"
          ? e.net_contents.value
          : undefined,
      producer:
        typeof e.producer.value === "string" || (e.producer.value && typeof e.producer.value === "object")
          ? (e.producer.value as DeclaredFields["producer"])
          : undefined,
      country_of_origin:
        typeof e.country_of_origin.value === "string"
          ? e.country_of_origin.value
          : undefined,
    };
    setAppPrefill((prev) => ({
      fields,
      source: "image-vision",
      filename: stage.file.name,
      version: (prev?.version ?? 0) + 1,
    }));
    setStage({
      kind: "single-pending",
      file: stage.file,
      previewUrl: stage.previewUrl,
    });
  }

  function reset() {
    revokeIfPreview(stage);
    // Revoke batch preview blob: URLs so the browser can free the
    // underlying image memory. Each was created in submitBatch and
    // held only while the batch view was on screen.
    for (const url of Object.values(batchPreviewByFilename)) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    setBatchPreviewByFilename({});
    setStage({ kind: "idle" });
    setAppPrefill(null);
    setBgAppParse({ kind: "idle" });
  }

  function handleApplicationParsed(payload: ApplicationParsePayload) {
    setAppPrefill((prev) => ({
      fields: payload.fields,
      source: payload.source,
      filename: payload.filename,
      version: (prev?.version ?? 0) + 1,
    }));
  }

  return (
    <div className="space-y-8">
      <ApiStatusBanner />
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Verify a label against application data
        </h2>
        <p className="mt-2 max-w-2xl text-slate-600 dark:text-slate-300">
          Upload a label image, then add the COLA application data (PDF,
          JSON, CSV, Markdown, text, or a photo of the form) — or fill
          the fields in manually. Returns a pass / fail / review verdict
          in seconds.
        </p>
        {/* The "extract-only" path is discoverable from a link below
            the form's primary Verify button. Surfacing it on idle adds
            two paragraphs to a screen the reviewer is trying to act on
            for the first time. Only surface it in detailed mode. */}
        <p className="detailed-only mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          No application data? You can still extract what&apos;s on the label.
        </p>
      </header>

      {stage.kind === "idle" && (
        <>
          <UploadZone onFiles={handleFiles} />
          {/* Sample affordance is detailed-only. A non-technical
              reviewer landing on the idle screen should see one
              primary action (drop your label) — three "try a sample"
              buttons compete for attention. Power users in detailed
              mode still get the one-click demo path. */}
          <div className="detailed-only">
            <SampleAffordance onPick={handleSample} />
          </div>
          {/* Review queue panel intentionally removed from the public
              idle screen — it required a DEBUG_TOKEN access code that
              confused non-operator visitors. Operators with the token
              hit /api/queue directly. User feedback 2026-05-13. */}
          <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm dark:border-slate-700 dark:bg-slate-900">
            <summary className="cursor-pointer font-medium text-slate-700 dark:text-slate-200">
              About this prototype
            </summary>
            <div className="mt-2 space-y-2 text-slate-600 dark:text-slate-300">
              <p>
                Verifies seven regulated fields per 27 CFR §16.21 / §16.22
                (Government Warning text, prefix all-caps, prefix bold,
                type-size minimum) and the COLA-declared fields (brand,
                class/type, ABV, net contents, producer, country).
              </p>
              <p>
                The Image Quality and Verdict columns are independent: a
                FAIL on image quality does not count as a non-compliant
                label.
              </p>
            </div>
          </details>
        </>
      )}

      {stage.kind === "single-pending" && (
        <div className="space-y-6">
          {bgAppParse.kind === "parsing" && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border-l-4 border-blue-500 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-400 dark:bg-blue-950/60 dark:text-blue-200"
            >
              <span aria-hidden className="mr-1">⏳</span>
              Parsing <span className="font-mono">{bgAppParse.filename}</span> — the form will pre-fill the empty fields in a moment. Feel free to start typing; any field you fill in yourself wins over the prefill.
            </div>
          )}
          {bgAppParse.kind === "failed" && (
            <div
              role="alert"
              className="rounded-lg border-l-4 border-yellow-500 bg-yellow-50 p-3 text-sm text-yellow-900 dark:border-yellow-400 dark:bg-yellow-950/60 dark:text-yellow-200"
            >
              <span aria-hidden className="mr-1">⚠</span>
              Couldn&apos;t auto-parse <span className="font-mono">{bgAppParse.filename}</span>. Try a different format, upload via the field below, or fill the form manually.
            </div>
          )}
          {ignoredApps.length > 0 && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400 dark:bg-amber-950/60 dark:text-amber-200"
            >
              <span aria-hidden className="mr-1">ℹ</span>
              You dropped {ignoredApps.length + 1} application files with one
              image. Only one application can verify a single label, so we
              kept the best filename-stem match and ignored{" "}
              <span className="font-mono">{ignoredApps.join('", "')}</span>.
              Drop multiple images to verify them in a batch.
            </div>
          )}
          <ApplicationUpload
            onParsed={handleApplicationParsed}
            imageFilename={stage.file.name}
          />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Uploaded image
              </h3>
              {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL from the user's upload, not a remote image */}
              <img
                src={stage.previewUrl}
                alt="Uploaded label preview"
                loading="lazy"
                decoding="async"
                className="max-h-96 w-full rounded-lg border border-slate-200 bg-white object-contain p-2 dark:border-slate-700 dark:bg-slate-900"
              />
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={reset}
                  className="rounded px-1 py-0.5 text-sm text-slate-500 underline hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                >
                  Replace image
                </button>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  or add more images below to verify them as a batch
                </span>
              </div>
              {/* "Add more files" affordance — primarily for iOS Safari,
                  whose picker often returns only a single photo per
                  tap. Each picker action APPENDS to the staged set
                  rather than replacing it. On desktop this is also
                  useful for "I forgot to include the application
                  PDF" mid-flow. If a second image lands the page
                  flips into batch mode automatically (handleFiles
                  intent-inference). */}
              <UploadZone
                mode="append"
                onFiles={handleAdditionalFiles}
              />
            </div>
            <DeclaredForm
              onSubmit={submitSingle}
              initial={appPrefill?.fields}
              onExtractOnly={submitExtractOnly}
            />
          </div>
        </div>
      )}

      {(stage.kind === "single-verifying" ||
        stage.kind === "single-extracting") && (
        <VerifyProgress
          verb={
            stage.kind === "single-verifying"
              ? "Checking the label"
              : "Extracting from the label"
          }
        />
      )}

      {stage.kind === "single-done" && (
        <SingleResult
          result={stage.result}
          imagePreviewUrl={stage.previewUrl}
          onAnother={reset}
          filename={stage.file.name}
        />
      )}

      {stage.kind === "single-extract-done" && (
        <ExtractionOnlyResult
          result={stage.result}
          imagePreviewUrl={stage.previewUrl}
          onAnother={reset}
          onContinueToVerification={continueToVerification}
        />
      )}

      {stage.kind === "single-error" && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          <h2 className="text-base font-semibold">{stage.title ?? "Verification failed"}</h2>
          <p className="mt-1">{stage.message}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stage.retrySample && (
              <button
                type="button"
                onClick={() => {
                  const sample = stage.retrySample!;
                  void handleSample(sample, stage.file);
                }}
                className="min-h-[44px] rounded-md bg-red-700 px-4 py-2.5 font-semibold text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500"
              >
                Retry this sample
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              className="min-h-[44px] rounded-md border border-red-300 bg-white px-4 py-2.5 font-semibold text-red-700 hover:bg-red-50 dark:border-red-700 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900"
            >
              {stage.retrySample ? "Start over" : "Try again"}
            </button>
          </div>
        </div>
      )}

      {stage.kind === "batch-pending" && stage.autoPair && (() => {
        // Auto-pair path: the drop contained at least one application
        // file alongside the images. The server's auto-pair handler
        // figures out which app goes with which image by filename
        // stem (case-insensitive, face-tag-stripped, app-tag-stripped)
        // and parses each app file — no manifest paste required. We
        // show the reviewer a "Detected" summary so they see what
        // will pair before they click Verify.
        const imageFiles = stage.files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
        const appFiles = stage.files.filter((f) => !imageFiles.includes(f));
        return (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                Batch upload — {imageFiles.length} image{imageFiles.length === 1 ? "" : "s"} + {appFiles.length} application file{appFiles.length === 1 ? "" : "s"}
              </h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                We&apos;ll match each image to its application file
                automatically. Hit <strong>Verify batch</strong> to
                start.
              </p>
              {stage.submitError && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200"
                >
                  <p className="font-semibold">Batch upload failed</p>
                  <p className="mt-0.5">{stage.submitError}</p>
                </div>
              )}
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                  <div className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Images ({imageFiles.length})
                  </div>
                  <ul className="mt-1 list-inside list-disc font-mono text-xs text-slate-700 dark:text-slate-200">
                    {imageFiles.slice(0, 8).map((f) => (
                      <li key={f.name}>{f.name}</li>
                    ))}
                    {imageFiles.length > 8 && (
                      <li className="list-none text-slate-500 dark:text-slate-400">
                        …and {imageFiles.length - 8} more
                      </li>
                    )}
                  </ul>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800">
                  <div className="text-label font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Application files ({appFiles.length})
                  </div>
                  <ul className="mt-1 list-inside list-disc font-mono text-xs text-slate-700 dark:text-slate-200">
                    {appFiles.slice(0, 8).map((f) => (
                      <li key={f.name}>{f.name}</li>
                    ))}
                    {appFiles.length > 8 && (
                      <li className="list-none text-slate-500 dark:text-slate-400">
                        …and {appFiles.length - 8} more
                      </li>
                    )}
                  </ul>
                </div>
              </div>
              {batchSubmitting && (
                <BatchProgress
                  phase={batchPhase}
                  imageCount={imageFiles.length}
                  appCount={appFiles.length}
                  uploadFraction={batchUploadFraction}
                  elapsedMs={
                    batchStartedAt ? Date.now() - batchStartedAt : 0
                  }
                />
              )}
              {/* iOS-tolerant additive staging — each "Add more files"
                  picker action appends rather than replaces, so an
                  iPhone user who needs the full batch can keep adding
                  one photo at a time without losing the previously-
                  staged set. Hidden while the batch POST is in flight. */}
              {!batchSubmitting && (
                <div className="mt-4">
                  <UploadZone
                    mode="append"
                    onFiles={handleAdditionalFiles}
                  />
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={batchSubmitting}
                  aria-busy={batchSubmitting || undefined}
                  onClick={() => {
                    // Auto-pair path. Pass empty manifest EXPLICITLY
                    // (don't rely on setManifestText("") since React
                    // state updates are async — submitBatch() would
                    // otherwise close over the OLD manifestText and
                    // route to the wrong server path. User-reported
                    // bug 2026-05-13.
                    void submitBatch("");
                  }}
                  className="min-h-[44px] rounded-md bg-blue-600 px-5 py-2.5 text-base font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-blue-500 dark:hover:bg-blue-400"
                >
                  {batchSubmitting
                    ? "Verifying…"
                    : `Verify batch (${imageFiles.length} pair${imageFiles.length === 1 ? "" : "s"})`}
                </button>
                <button
                  type="button"
                  disabled={batchSubmitting}
                  onClick={reset}
                  className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-slate-500 dark:text-slate-400">
                  Need to override pairing or edit fields per image?
                </summary>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Paste a CSV / JSON manifest below to override auto-pairing.
                  Required column: <code>filename</code>. Optional:{" "}
                  <code>brand_name</code>, <code>class_type</code>,{" "}
                  <code>class_category</code>, <code>abv_percent</code>,{" "}
                  <code>net_contents</code>, <code>producer</code>,{" "}
                  <code>country_of_origin</code>.
                </p>
                <textarea
                  rows={6}
                  value={manifestText}
                  onChange={(e) => setManifestText(e.target.value)}
                  aria-label="Batch manifest override (CSV or JSON)"
                  className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                  placeholder={`filename,brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\nlabel-001.png,Stone's Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,USA`}
                />
                {manifestText.trim() && (
                  <button
                    type="button"
                    disabled={batchSubmitting}
                    onClick={() => void submitBatch()}
                    className="mt-2 min-h-[44px] rounded-md border border-blue-500 px-4 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40"
                  >
                    {batchSubmitting ? "Submitting…" : "Submit with manifest override"}
                  </button>
                )}
              </details>
            </div>
          </div>
        );
      })()}

      {stage.kind === "batch-pending" && !stage.autoPair && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Batch upload — {stage.files.length} image
              {stage.files.length === 1 ? "" : "s"}
            </h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              <strong>Drop your application data below</strong> — a single CSV
              or JSON with one row per image (a <code className="rounded bg-slate-100 px-1 dark:bg-slate-800 dark:text-slate-200">filename</code> column tells us
              which row goes with which image), a single PDF / DOCX that
              describes the same product across all your images, or N
              individual PDFs / JSONs with filenames matching your images.
              We&apos;ll figure out the pairing automatically.
            </p>
            {stage.submitError && (
              <div
                role="alert"
                aria-live="assertive"
                className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200"
              >
                <p className="font-semibold">Batch upload failed</p>
                <p className="mt-0.5">{stage.submitError}</p>
              </div>
            )}
            {/* Primary path: file-upload dropzone for the application
                file(s). Accepts the same MIMEs as the main UploadZone.
                Uses `mode="append"` and `handleAdditionalFiles` so the
                ordering / dedupe semantics match the rest of the
                "Add more files" flow — and so iOS users on this
                screen also get the per-platform multi-tap hint. The
                router detects apps and flips autoPair=true, which
                moves the user into the "Detected" summary screen. */}
            <div className="mt-4">
              <UploadZone
                mode="append"
                onFiles={handleAdditionalFiles}
              />
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-slate-500 dark:text-slate-400">
                Advanced: paste a CSV/JSON manifest manually
              </summary>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Required column: <code>filename</code>. Other supported
                columns: <code>brand_name</code>, <code>class_type</code>,{" "}
                <code>class_category</code>, <code>abv_percent</code>,{" "}
                <code>net_contents</code> (e.g. <code>12 fl_oz</code>),{" "}
                <code>producer</code>, <code>country_of_origin</code>.
              </p>
              <textarea
                rows={6}
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                aria-label="Batch manifest (CSV or JSON)"
                className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                placeholder={`filename,brand_name,class_type,class_category,abv_percent,net_contents,country_of_origin\nlabel-001.png,Stone's Throw IPA,India Pale Ale,beer,6.4,12 fl_oz,USA`}
              />
              {manifestText.trim() && (
                <button
                  type="button"
                  disabled={batchSubmitting}
                  onClick={() => void submitBatch()}
                  className="mt-2 min-h-[44px] rounded-md border border-blue-500 px-4 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40"
                >
                  {batchSubmitting ? "Submitting…" : "Submit with pasted manifest"}
                </button>
              )}
            </details>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={reset}
                className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {stage.kind === "batch-running" && (
        <BatchView
          batchId={stage.batchId}
          rows={stage.rows}
          onDone={() => undefined}
          imagePreviewByFilename={batchPreviewByFilename}
        />
      )}
    </div>
  );
}
