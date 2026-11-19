// Page-level regressions from the 2026-11-13 design audit.
//
//  • Warmup: the page fired `fetch("/api/warmup")` and never read the
//    body. Chromium keeps such a request open, so the page never reached
//    network idle. The body must be consumed or cancelled.
//  • Cancel: pressing Cancel during a sample run showed a red
//    "Verification failed" panel. Cancelling is not a failure; the user
//    goes back to the sample picker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom cannot decode images, so the canvas compressor would never
// resolve. Pass files through unchanged.
vi.mock("@/lib/client-compress", () => ({
  compressImageInBrowser: async (f: File) => f,
}));

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

let warmupResponse: Response | null = null;
let verifyHandler: Handler;

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/warmup")) {
        warmupResponse = new Response(
          JSON.stringify({ ok: true, tesseract: "ok", warmupMs: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
        return warmupResponse;
      }
      if (url.includes("/api/health")) {
        return new Response(JSON.stringify({ ok: true, ready: true, notes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/samples/")) {
        return new Response(new Blob([new Uint8Array(64)], { type: "image/jpeg" }), {
          status: 200,
        });
      }
      if (url.includes("/api/verify")) return verifyHandler(url, init);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

/** A verify request that only settles when its signal aborts. */
const hangUntilAborted: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    });
  });

beforeEach(() => {
  warmupResponse = null;
  verifyHandler = hangUntilAborted;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderHome() {
  const { default: Home } = await import("@/app/page");
  return render(<Home />);
}

describe("warmup request", () => {
  it("consumes or cancels the /api/warmup response body", async () => {
    await renderHome();
    await waitFor(() => expect(warmupResponse).not.toBeNull());
    // bodyUsed turns true once the body is read or its stream cancelled.
    await waitFor(() => expect(warmupResponse?.bodyUsed).toBe(true));
  });
});

describe("Cancel during a sample run", () => {
  it("returns to the sample picker without a failure panel", async () => {
    const user = userEvent.setup();
    await renderHome();
    await user.click(await screen.findByRole("button", { name: /FAIL sample/ }));
    const cancel = await screen.findByRole("button", { name: /^Cancel/ });
    await act(async () => {
      await user.click(cancel);
    });
    // Let the aborted fetch's rejection run through the handler.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText(/Verification failed/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /FAIL sample/ })).toBeInTheDocument();
    // The cancel is announced politely, not as an error.
    expect(screen.getByTestId("page-announcer").textContent).toMatch(/cancel/i);
  });

  it("still shows a failure panel when a sample run really fails", async () => {
    verifyHandler = async () =>
      new Response(JSON.stringify({ error: "Internal" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const user = userEvent.setup();
    await renderHome();
    await user.click(await screen.findByRole("button", { name: /FAIL sample/ }));
    expect(await screen.findByText(/Verification failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry this sample/ })).toBeInTheDocument();
  });
});
