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
    // @ts-expect-error
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
});
