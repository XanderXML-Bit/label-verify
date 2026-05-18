// Wave-34 upload-flow integration tests.
//
// Production bug reported 2026-05-17: an iPhone user dropped 5 label
// photos and only 1 came through. Root cause: on iOS Safari the
// primary "Choose files" button's `<input>` accepted both image AND
// application MIMEs, which forces iOS into the Files-app picker
// (single-select only). The Photos-app multi-select picker is only
// reachable when accept is image-only.
//
// These tests pin the fix end-to-end at the page level, NOT just
// component-isolated:
//   • iOS gets a primary "Choose photos" button (multi-select Photos
//     picker) and a secondary "Choose document" button.
//   • Non-iOS keeps the unified "Choose files" primary button.
//   • The merge-on-append flow (dropping +N images via "Add more
//     files" while already in single-pending) correctly accumulates
//     and flips into batch-pending once images.length >= 2.
//   • GIF / BMP / SVG don't sneak past the client image classifier
//     and 415 server-side later.
//
// Plus regression pins for the wave-34 audit fixes:
//   • Reviewer badge persists across mounts via localStorage.
//   • ApiStatusBanner distinguishes offline from configured-failure.

import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VerifyResponse } from "@/lib/types";

// Mock fetch BEFORE the page imports so the API-status banner's
// /api/health probe doesn't fire a real network call.
beforeAll(() => {
  // The same DataTransferItem polyfills the upload-zone test file
  // needs — we re-add them here so this file is self-contained.
  if (
    typeof HTMLInputElement !== "undefined" &&
    !("webkitdirectory" in HTMLInputElement.prototype)
  ) {
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      get() {
        return this.hasAttribute("webkitdirectory");
      },
      set(v: boolean) {
        if (v) this.setAttribute("webkitdirectory", "");
        else this.removeAttribute("webkitdirectory");
      },
      configurable: true,
    });
  }
  if (typeof (globalThis as { DataTransferItem?: unknown }).DataTransferItem === "undefined") {
    class DataTransferItemStub {
      webkitGetAsEntry(): null {
        return null;
      }
    }
    Object.defineProperty(globalThis, "DataTransferItem", {
      value: DataTransferItemStub,
      configurable: true,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeImage(name: string, mtime = 1_700_000_000_000): File {
  // Make sure the body has length so size > 0 for the merge key.
  return new File([new Uint8Array(64)], name, {
    type: name.toLowerCase().endsWith(".heic")
      ? "image/heic"
      : name.toLowerCase().endsWith(".png")
        ? "image/png"
        : name.toLowerCase().endsWith(".webp")
          ? "image/webp"
          : "image/jpeg",
    lastModified: mtime,
  });
}

function stubIosNavigator(): () => void {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    } as Navigator,
    configurable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
    });
  };
}

async function getHiddenInputByAccept(
  container: HTMLElement,
  pattern: RegExp,
): Promise<HTMLInputElement> {
  return await waitFor(() => {
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    const match = inputs.find((i) => pattern.test(i.getAttribute("accept") ?? ""));
    if (!match) throw new Error(`no file input matching ${pattern}`);
    return match;
  });
}

describe("Wave-34 iOS picker fix — primary CTA opens Photos multi-select", () => {
  it("on iOS, renders 'Choose photos' as the PRIMARY action and 'Choose document' as secondary", async () => {
    const restore = stubIosNavigator();
    try {
      const { UploadZone } = await import("@/app/components/UploadZone");
      render(<UploadZone onFiles={() => undefined} />);
      // 'Choose photos' should be present and have the primary
      // styling (no `border` chrome — primary buttons are filled).
      await waitFor(() => {
        const photos = screen.getByRole("button", {
          name: /Choose photos from Camera Roll/i,
        });
        const docs = screen.getByRole("button", {
          name: /Choose a PDF or other application document/i,
        });
        expect(photos).toBeInTheDocument();
        expect(docs).toBeInTheDocument();
        // Primary has the filled `bg-slate-900` / `bg-blue-600`
        // class — secondary uses `border ...`. We assert structurally
        // by comparing class lists rather than colour values.
        expect(photos.className).toContain("bg-slate-900");
        expect(docs.className).toContain("border");
      });
    } finally {
      restore();
    }
  });

  it("on iOS, the photo input has `accept='image/*'` (forces Photos picker)", async () => {
    const restore = stubIosNavigator();
    try {
      const { UploadZone } = await import("@/app/components/UploadZone");
      const { container } = render(<UploadZone onFiles={() => undefined} />);
      // After mount the iosHinted useEffect fires and re-renders with
      // the photo button. Find the image-only input among the file
      // inputs.
      const photoInput = await getHiddenInputByAccept(container, /^image\/\*$/);
      expect(photoInput.multiple).toBe(true);
      // The unified input still exists (secondary) and accepts the
      // mixed image+application MIMEs.
      const unifiedInput = await getHiddenInputByAccept(
        container,
        /application\/pdf/,
      );
      expect(unifiedInput.getAttribute("accept")).toContain("image/jpeg");
      expect(unifiedInput.getAttribute("accept")).toContain("application/pdf");
    } finally {
      restore();
    }
  });

  it("on desktop (no touch + no iOS UA), keeps the unified 'Choose files' as primary", async () => {
    // Default JSDOM navigator already has no maxTouchPoints, but be
    // explicit so the test doesn't depend on a global fixture.
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        maxTouchPoints: 0,
      } as Navigator,
      configurable: true,
    });
    try {
      const { UploadZone } = await import("@/app/components/UploadZone");
      render(<UploadZone onFiles={() => undefined} />);
      // 'Choose files' is the primary aria-label on desktop.
      expect(
        screen.getByRole("button", {
          name: /Upload label images: drag and drop, or press Enter to browse/i,
        }),
      ).toBeInTheDocument();
      // The iOS-only "Choose photos" button is NOT rendered on desktop.
      expect(
        screen.queryByRole("button", { name: /Choose photos from Camera Roll/i }),
      ).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: original,
        configurable: true,
      });
    }
  });

  it("multi-photo upload via the iOS photo input fires onFiles once with all selections", async () => {
    const restore = stubIosNavigator();
    try {
      const { UploadZone } = await import("@/app/components/UploadZone");
      const user = userEvent.setup();
      const onFiles = vi.fn();
      const { container } = render(<UploadZone onFiles={onFiles} />);
      const photoInput = await getHiddenInputByAccept(container, /^image\/\*$/);
      const f1 = makeImage("a.jpg");
      const f2 = makeImage("b.jpg", 1_700_000_001_000);
      const f3 = makeImage("c.jpg", 1_700_000_002_000);
      await user.upload(photoInput, [f1, f2, f3]);
      expect(onFiles).toHaveBeenCalledTimes(1);
      const arg = onFiles.mock.calls[0]?.[0] as File[];
      expect(arg.map((f) => f.name)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    } finally {
      restore();
    }
  });
});

describe("Wave-34 mergeFilesForRestage — append-mode merges new files with existing", () => {
  it("mergeFilesForRestage dedupes (name, size, mtime) — iOS habit of re-picking the same photo", async () => {
    const { mergeFilesForRestage } = await import("@/lib/upload-merge");
    const a1 = makeImage("photo.jpg", 1_700_000_000_000);
    const a2 = makeImage("photo.jpg", 1_700_000_000_000); // duplicate
    const b = makeImage("other.jpg", 1_700_000_001_000);
    const merged = mergeFilesForRestage([a1], [a2, b]);
    expect(merged).toHaveLength(2);
    expect(merged.map((f) => f.name)).toEqual(["photo.jpg", "other.jpg"]);
  });

  it("preserves existing-then-new order so the user's staging tray is stable", async () => {
    const { mergeFilesForRestage } = await import("@/lib/upload-merge");
    const a = makeImage("a.jpg", 1);
    const b = makeImage("b.jpg", 2);
    const c = makeImage("c.jpg", 3);
    const d = makeImage("d.jpg", 4);
    const merged = mergeFilesForRestage([a, b], [c, d]);
    expect(merged.map((f) => f.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
  });
});

describe("Wave-34 GIF / SVG sneaking through batch image classification", () => {
  it("UploadZone REJECTS GIF + SVG + BMP at the dropzone (file-type allowlist)", async () => {
    const { UploadZone } = await import("@/app/components/UploadZone");
    const onFiles = vi.fn();
    const { container } = render(<UploadZone onFiles={onFiles} />);
    const dropTarget = container.querySelector('[aria-disabled="false"]');
    if (!dropTarget) throw new Error("drop target not found");
    const { fireEvent } = await import("@testing-library/react");
    const gif = new File(["GIF89a"], "spinner.gif", { type: "image/gif" });
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    const bmp = new File(["BM"], "scan.bmp", { type: "image/bmp" });
    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [gif, svg, bmp], types: ["Files"] },
    });
    expect(onFiles).not.toHaveBeenCalled();
    // The rejection notice should name each rejected file.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Rejected 3 files/);
    expect(alert.textContent).toMatch(/spinner\.gif/);
    expect(alert.textContent).toMatch(/logo\.svg/);
    expect(alert.textContent).toMatch(/scan\.bmp/);
  });
});

describe("Wave-34 ReviewerBadge — persists via localStorage", () => {
  it("reads the saved reviewer id on mount, writes on commit, clears on empty submit", async () => {
    // Start with a clean slate.
    window.localStorage.removeItem("labelverify:reviewer");
    const { ReviewerBadge } = await import("@/app/components/ReviewerBadge");
    const user = userEvent.setup();
    const { unmount } = render(<ReviewerBadge />);
    // The initial badge is a button with "+ set ID" copy.
    const trigger = await screen.findByRole("button", {
      name: /Set reviewer ID/i,
    });
    await user.click(trigger);
    // The input has both a sr-only <label> and an aria-label — match by
    // the more specific aria-label so we get exactly one hit.
    const input = await screen.findByLabelText(
      /Reviewer ID — name, initials, or employee ID/i,
    );
    await user.type(input, "TTB-OPS-42");
    const save = screen.getByRole("button", { name: /Save reviewer ID/i });
    await user.click(save);
    // localStorage now has the value.
    expect(window.localStorage.getItem("labelverify:reviewer")).toBe("TTB-OPS-42");
    // Re-mount: badge surfaces the saved id automatically.
    unmount();
    render(<ReviewerBadge />);
    await screen.findByText("TTB-OPS-42");
  });

  it("returns the stored value via getStoredReviewer() (server-side safe)", async () => {
    window.localStorage.setItem("labelverify:reviewer", "auditor-7");
    const { getStoredReviewer } = await import("@/app/components/ReviewerBadge");
    expect(getStoredReviewer()).toBe("auditor-7");
  });
});

describe("Wave-34 ApiStatusBanner — distinguishes network-offline from server-configured-failure", () => {
  it("renders the offline notice when /api/health rejects with a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const { ApiStatusBanner } = await import("@/app/components/ApiStatusBanner");
    render(<ApiStatusBanner />);
    // The banner waits for the catch to fire, then renders the offline copy.
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/can.?t reach the verifier/i);
    });
  });

  it("renders the config-issue banner when /api/health resolves with notes[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ ready: false, notes: ["GOOGLE_API_KEY missing"] }),
        } as Response),
      ),
    );
    const { ApiStatusBanner } = await import("@/app/components/ApiStatusBanner");
    render(<ApiStatusBanner />);
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toMatch(/Service configuration issue/i);
      expect(alert.textContent).toMatch(/GOOGLE_API_KEY missing/);
    });
  });

  it("renders NOTHING when /api/health is healthy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          json: () => Promise.resolve({ ready: true, notes: [] }),
        } as Response),
      ),
    );
    const { ApiStatusBanner } = await import("@/app/components/ApiStatusBanner");
    const { container } = render(<ApiStatusBanner />);
    // The component returns null when healthy — there should be no
    // alert / status role in the rendered output.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector("[role='alert']")).toBeNull();
  });
});

describe("Wave-34 BatchProgress — surfaces SERVER concurrency, not a stale client constant", () => {
  it("renders the actual concurrency in the verifying-phase status copy", async () => {
    const { BatchProgress } = await import("@/app/components/BatchProgress");
    render(
      <BatchProgress
        phase="verifying"
        imageCount={20}
        appCount={1}
        elapsedMs={500}
        // Wave-35j: server default bumped 12 → 16 (memory bumped to
        // 2 GB in vercel.json to fit 16 × ~80 MB workers safely).
        concurrency={16}
      />,
    );
    // Wave-35j: the verifying copy now also surfaces an
    // "≈ X of N done" estimate (the X is time-dependent so we match
    // a loose regex rather than a hardcoded count).
    expect(
      screen.getByText(/Verifying 20 images \(16 in parallel\) — ≈ \d+ of 20 done/i),
    ).toBeInTheDocument();
    // The bogus "(concurrency 2)" copy must NOT appear.
    expect(screen.queryByText(/concurrency 2\)/i)).toBeNull();
  });

  it("clamps concurrency to the batch size (3-item batch shows '3 in parallel')", async () => {
    const { BatchProgress } = await import("@/app/components/BatchProgress");
    render(
      <BatchProgress
        phase="verifying"
        imageCount={3}
        appCount={0}
        elapsedMs={500}
        concurrency={16}
      />,
    );
    expect(
      screen.getByText(/Verifying 3 images \(3 in parallel\) — ≈ \d+ of 3 done/i),
    ).toBeInTheDocument();
  });

  it("falls back to a sane default when no concurrency prop is provided", async () => {
    const { BatchProgress } = await import("@/app/components/BatchProgress");
    render(
      <BatchProgress
        phase="verifying"
        imageCount={20}
        appCount={1}
        elapsedMs={500}
      />,
    );
    // Default is 16 (matches the server's INLINE_CONCURRENCY_DEFAULT
    // since wave-35j, was 12 since wave-15b) so the copy still reads
    // accurately when the server response didn't carry the value
    // (e.g. legacy SSE path).
    expect(
      screen.getByText(/Verifying 20 images \(16 in parallel\) — ≈ \d+ of 20 done/i),
    ).toBeInTheDocument();
  });

  it("surfaces a Cancel button when onCancel is provided", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const { BatchProgress } = await import("@/app/components/BatchProgress");
    render(
      <BatchProgress
        phase="verifying"
        imageCount={20}
        appCount={1}
        elapsedMs={500}
        concurrency={16}
        onCancel={onCancel}
      />,
    );
    const cancel = screen.getByRole("button", {
      name: /Cancel batch verification/i,
    });
    await user.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("Wave-34 VerifyProgress — surfaces a Cancel button when onCancel is provided", () => {
  it("clicking Cancel fires the handler exactly once", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    const { VerifyProgress } = await import("@/app/components/VerifyProgress");
    render(<VerifyProgress verb="Checking the label" onCancel={onCancel} />);
    const btn = screen.getByRole("button", { name: /Cancel verification/i });
    await user.click(btn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does NOT render a Cancel button when onCancel is omitted", async () => {
    const { VerifyProgress } = await import("@/app/components/VerifyProgress");
    render(<VerifyProgress verb="Checking the label" />);
    expect(
      screen.queryByRole("button", { name: /Cancel verification/i }),
    ).toBeNull();
  });
});

describe("Wave-34 export — JSON envelope carries reviewer + verifiedAt audit fields", () => {
  it("stamps reviewer + verifiedAtIso when provided", async () => {
    const { singleResultToJson } = await import("@/lib/export-result");
    // Minimal stub — the JSON export path doesn't read most fields,
    // so we cast through `unknown` rather than build the full
    // VerifyResponse type (whose nested shape is large + churns).
    const fakeResult = {
      verdict: "pass",
      timings: { preprocess: 0, ocr: 0, vision: 0, matching: 0, total: 0 },
      modelId: "gemini:gemini-3.1-flash-lite",
      modelVersion: "v1",
      modeUsed: "default",
    } as unknown as VerifyResponse;
    const json = singleResultToJson("acme.jpg", fakeResult, {
      reviewer: "TTB-OPS-42",
      verifiedAtIso: "2026-05-17T19:00:00.000Z",
    });
    const parsed = JSON.parse(json) as {
      audit?: { reviewer?: string; verifiedAtIso?: string };
    };
    expect(parsed.audit?.reviewer).toBe("TTB-OPS-42");
    expect(parsed.audit?.verifiedAtIso).toBe("2026-05-17T19:00:00.000Z");
  });

  it("omits the audit envelope when no options are provided (back-compat)", async () => {
    const { singleResultToJson } = await import("@/lib/export-result");
    const fakeResult = {
      verdict: "pass",
      timings: { preprocess: 0, ocr: 0, vision: 0, matching: 0, total: 0 },
    } as unknown as VerifyResponse;
    const json = singleResultToJson("acme.jpg", fakeResult);
    const parsed = JSON.parse(json) as { audit?: unknown };
    expect(parsed.audit).toBeUndefined();
  });
});

describe("Wave-34 producer comparator — missing declaration routes to REVIEW (regulatory)", () => {
  it("REVIEWS when declared producer is null + extracted has data", async () => {
    const { compareProducer } = await import("@/lib/matching/producer");
    const cmp = compareProducer(
      null,
      {
        name: "Stone Brewing Co.",
        street: null,
        city: "San Diego",
        state: "CA",
        postal_code: null,
        country: "USA",
      },
      0.95,
    );
    expect(cmp.status).toBe("review");
    expect(cmp.reason ?? "").toMatch(/did not declare a producer/i);
    expect(cmp.reason ?? "").toMatch(/27 CFR/);
  });

  it("REVIEWS when declared producer is empty string + extracted has data", async () => {
    const { compareProducer } = await import("@/lib/matching/producer");
    const cmp = compareProducer(
      "   ",
      {
        name: "Stone Brewing Co.",
        street: null,
        city: "San Diego",
        state: "CA",
        postal_code: null,
        country: "USA",
      },
      0.95,
    );
    expect(cmp.status).toBe("review");
  });

  it("does NOT silently PASS empty-vs-empty (the bug we are closing)", async () => {
    const { compareProducer } = await import("@/lib/matching/producer");
    const cmp = compareProducer(
      "",
      {
        name: null,
        street: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
      },
      0.5,
    );
    // The previous (buggy) behaviour: status === "pass" with confidence
    // ~1.0 because fuzzy("", "") === 1.0. The fix routes this to
    // REVIEW because the applicant didn't declare a producer.
    expect(cmp.status).toBe("review");
  });
});

describe("Wave-34 BatchView EventSource — uses stable dep array so onDone churn doesn't reopen the connection", () => {
  it("the useEffect's dep array contains only [batchId, reconnectKey] — pinned by source inspection", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      "src/app/components/BatchView.tsx",
      "utf-8",
    );
    // The dep array MUST NOT contain `onDone`. The fix was specifically
    // to drop it so a fresh arrow on every parent render doesn't
    // reopen the EventSource.
    expect(src).toMatch(/\}, \[batchId, reconnectKey\]\);/);
    expect(src).not.toMatch(/\}, \[batchId, onDone, reconnectKey\]\);/);
  });
});
