import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BatchView, type BatchRow } from "@/app/components/BatchView";

// Minimal EventSource stub. Tests don't dispatch events — we just need
// the constructor not to throw when BatchView mounts.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState: number = 0;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  close = vi.fn();
  static CLOSED = 2;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
}

describe("BatchView", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    // @ts-expect-error — jsdom doesn't ship EventSource
    globalThis.EventSource = MockEventSource;
  });
  afterEach(() => {
    // @ts-expect-error — jsdom doesn't ship EventSource, so the global is custom-installed
    delete globalThis.EventSource;
  });

  const rows: BatchRow[] = [
    { index: 0, filename: "a.png", status: "pending" },
    { index: 1, filename: "b.png", status: "pending" },
  ];

  it("renders the heading, the row filenames, and the progress region", () => {
    render(<BatchView batchId="b1" rows={rows} onDone={() => undefined} />);
    expect(
      screen.getByRole("heading", { name: /batch verification/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("a.png")).toBeInTheDocument();
    expect(screen.getByText("b.png")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("opens an EventSource against the supplied batchId on mount", () => {
    render(<BatchView batchId="b42" rows={rows} onDone={() => undefined} />);
    expect(MockEventSource.instances[0]?.url).toBe(
      "/api/verify/batch/b42/stream",
    );
  });

  it("filter pills are clickable and toggle the active state", () => {
    render(<BatchView batchId="b1" rows={rows} onDone={() => undefined} />);
    const failPill = screen.getByRole("button", { name: /Fail \(0\)/ });
    fireEvent.click(failPill);
    expect(failPill).toHaveAttribute("aria-pressed", "true");
  });

  it("renders thumbnails when imagePreviewByFilename has matching keys", () => {
    // Wave-9 thumbnail contract: BatchView looks up each row's filename
    // in imagePreviewByFilename and renders <img src={blob:URL}> if a
    // match exists. This test pins the contract so the wiring can't
    // silently break (e.g. if a future refactor renames the prop or
    // changes the lookup key shape).
    const previews = {
      "a.png": "blob:http://localhost/abc",
      "b.png": "blob:http://localhost/def",
    };
    render(
      <BatchView
        batchId="b1"
        rows={rows}
        onDone={() => undefined}
        imagePreviewByFilename={previews}
      />,
    );
    const thumbs = screen
      .getAllByRole("img")
      .filter((el) => (el as HTMLImageElement).alt.startsWith("Thumbnail of"));
    expect(thumbs).toHaveLength(2);
    expect((thumbs[0] as HTMLImageElement).src).toBe(
      "blob:http://localhost/abc",
    );
    expect((thumbs[1] as HTMLImageElement).src).toBe(
      "blob:http://localhost/def",
    );
  });

  it("renders the dashed-placeholder when no preview is bound for a row", () => {
    // Defense-in-depth: when imagePreviewByFilename is omitted entirely
    // OR the row's filename isn't in the map, the row falls back to a
    // 12-square dashed placeholder. This is the visual signal the user
    // would see if the wiring is broken — surfaces the bug instead of
    // silently dropping the thumbnail column.
    const { container } = render(
      <BatchView batchId="b1" rows={rows} onDone={() => undefined} />,
    );
    // No <img> thumbnails — only the dashed-placeholder divs.
    expect(
      container.querySelectorAll('img[alt^="Thumbnail of"]'),
    ).toHaveLength(0);
    // The placeholders are rendered with the dashed-border classes.
    const placeholders = container.querySelectorAll(
      'div[aria-hidden][class*="border-dashed"]',
    );
    expect(placeholders.length).toBeGreaterThanOrEqual(2);
  });

  it("WAVE-15: forgiving lookup — basename match across path-prefix drift", () => {
    // Defensive fallback for the most likely production failure mode:
    // server's `r.filename` differs from the previewMap key by a
    // path prefix (e.g. folder-pick path-prefix drift). The lookup
    // walks the keys and matches by basename, surfacing the thumbnail
    // anyway.
    const previews = {
      "subfolder/a.png": "blob:http://localhost/abc",
      "subfolder/b.png": "blob:http://localhost/def",
    };
    render(
      <BatchView
        batchId="b1"
        rows={rows}
        onDone={() => undefined}
        imagePreviewByFilename={previews}
      />,
    );
    const thumbs = screen
      .getAllByRole("img")
      .filter((el) => (el as HTMLImageElement).alt.startsWith("Thumbnail of"));
    expect(thumbs).toHaveLength(2);
    expect((thumbs[0] as HTMLImageElement).src).toBe(
      "blob:http://localhost/abc",
    );
  });

  it("WAVE-15: forgiving lookup — URI-encoded filename", () => {
    // The server may URL-encode filenames containing spaces or
    // non-ASCII characters when echoing back. The forgiving lookup
    // tries decodeURIComponent before falling through.
    const rowsWithEncoded: BatchRow[] = [
      { index: 0, filename: "my%20label.png", status: "pending" },
    ];
    const previews = { "my label.png": "blob:http://localhost/encoded" };
    render(
      <BatchView
        batchId="b1"
        rows={rowsWithEncoded}
        onDone={() => undefined}
        imagePreviewByFilename={previews}
      />,
    );
    const thumb = screen
      .getAllByRole("img")
      .find((el) =>
        (el as HTMLImageElement).alt.startsWith("Thumbnail of"),
      );
    expect(thumb).toBeDefined();
    expect((thumb as HTMLImageElement).src).toBe(
      "blob:http://localhost/encoded",
    );
  });

  it("falls back to the placeholder when the row filename does not match any preview key", () => {
    // The MOST LIKELY production failure mode: client and server agree
    // on filename strings but they happen to differ (encoding, path
    // strip, folder-pick basename collision, etc.). Pin the fallback so
    // the BatchView never crashes on a missing key.
    const previews = { "different-name.png": "blob:http://localhost/xyz" };
    const { container } = render(
      <BatchView
        batchId="b1"
        rows={rows}
        onDone={() => undefined}
        imagePreviewByFilename={previews}
      />,
    );
    expect(
      container.querySelectorAll('img[alt^="Thumbnail of"]'),
    ).toHaveLength(0);
  });
});
