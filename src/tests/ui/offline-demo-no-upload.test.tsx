// Offline demo must not upload a visitor's own files.
//
// The public build makes no model calls, so the server cannot verify a
// visitor's label image or parse their application. Before this fix the
// page still sent those files: an image to /api/verify or /api/extract,
// documents to /api/application/parse. This suite records every fetch
// and XMLHttpRequest the page makes and fails if any request body
// carries a File or Blob while the page is in offline-demo mode.
//
// The last test is a control: with the live build marker, the same
// drop does upload, which proves the recorder would catch a leak.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OFFLINE_UPLOAD_BLOCKED } from "@/lib/demo-copy";

// jsdom cannot decode images, so the canvas compressor would never
// resolve. Pass files through unchanged.
vi.mock("@/lib/client-compress", () => ({
  compressImageInBrowser: async (f: File) => f,
}));

interface Sent {
  readonly url: string;
  readonly hasFile: boolean;
}

let sent: Sent[] = [];

function bodyHasFile(body: unknown): boolean {
  if (body instanceof Blob) return true;
  if (body instanceof FormData) {
    for (const [, value] of body.entries()) {
      if (typeof value !== "string") return true;
    }
  }
  return false;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installRecorders(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      sent.push({ url, hasFile: bodyHasFile(init?.body) });
      if (url.includes("/api/warmup")) return json({ ok: true });
      if (url.includes("/api/health")) return json({ ok: true, ready: true, notes: [] });
      if (url.includes("/samples/")) {
        return new Response(new Blob([new Uint8Array(64)], { type: "image/jpeg" }));
      }
      if (url.includes("/api/application/parse")) {
        return json({ fields: {}, source: "json", warnings: [], confidence: "low" });
      }
      return json({ error: "stub" }, 503);
    }),
  );
  class RecordingXhr {
    upload = {};
    status = 0;
    response: unknown = null;
    responseText = "";
    responseType = "";
    private url = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string): void {
      this.url = url;
    }
    send(body: unknown): void {
      sent.push({ url: this.url, hasFile: bodyHasFile(body) });
      this.onerror?.();
    }
    abort(): void {}
  }
  vi.stubGlobal("XMLHttpRequest", RecordingXhr);
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"]:not([webkitdirectory])',
  );
  if (!input) throw new Error("upload input not found");
  return input;
}

async function renderHome() {
  const { default: Home } = await import("@/app/page");
  return render(<Home />);
}

function uploadsWithFiles(): Sent[] {
  return sent.filter((s) => s.hasFile);
}

const image = () => new File([new Uint8Array(32)], "my-label.png", { type: "image/png" });
const image2 = () => new File([new Uint8Array(32)], "my-label-2.png", { type: "image/png" });
const app = () =>
  new File([JSON.stringify({ brand_name: "Visitor Brand" })], "my-label.json", {
    type: "application/json",
  });

beforeEach(() => {
  sent = [];
  document.documentElement.dataset.demo = "offline";
  installRecorders();
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.demo;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offline demo: a visitor's own files never leave the browser", () => {
  const cases: Array<[string, () => File[]]> = [
    ["one label image", () => [image()]],
    ["an application document", () => [app()]],
    ["an image with its application", () => [image(), app()]],
    ["several images (batch)", () => [image(), image2(), app()]],
  ];

  for (const [name, files] of cases) {
    it(`sends no file for ${name} and says it was not uploaded`, async () => {
      const user = userEvent.setup({ applyAccept: false });
      const { container } = await renderHome();
      await user.upload(fileInput(container), files());
      // Give any background parse or submit a chance to fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(await screen.findByTestId("offline-upload-blocked")).toHaveTextContent(
        OFFLINE_UPLOAD_BLOCKED,
      );
      // The form, the application box and the batch screen never open.
      expect(screen.queryByRole("button", { name: /^Verify/ })).toBeNull();
      expect(uploadsWithFiles()).toEqual([]);
      for (const s of sent) {
        expect(s.url).not.toMatch(/\/api\/(verify|extract|application\/parse)/);
      }
    });
  }

  it("still runs a sample without sending image bytes", async () => {
    const user = userEvent.setup();
    await renderHome();
    await user.click(await screen.findByRole("button", { name: /PASS sample/ }));
    await waitFor(() => expect(sent.some((s) => s.url.includes("/api/verify"))).toBe(true));
    expect(uploadsWithFiles()).toEqual([]);
  });
});

describe("control: the live build does upload", () => {
  it("the recorder sees the application file when the page is not offline", async () => {
    document.documentElement.dataset.demo = "live";
    const user = userEvent.setup({ applyAccept: false });
    const { container } = await renderHome();
    await user.upload(fileInput(container), [image(), app()]);
    await waitFor(() =>
      expect(uploadsWithFiles().map((s) => s.url)).toContain("/api/application/parse"),
    );
  });
});
