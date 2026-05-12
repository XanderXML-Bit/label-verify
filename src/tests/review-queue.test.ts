import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueForReview,
  dequeueForReview,
  peekQueue,
  markResolved,
  getStats,
  makeReviewItemId,
  MAX_QUEUE_SIZE,
  _resetReviewQueueForTests,
  type ReviewQueueItem,
} from "@/lib/review-queue";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";

// Minimal stub VerifyResponse — the queue only stores it; it doesn't inspect
// the inside. We cast to keep the test fixture small.
const STUB_RESPONSE = { verdict: "review" } as unknown as VerifyResponse;
const STUB_DECLARED = {
  brand_name: "Acme",
  class_type: "Pale Ale",
  class_category: "beer",
  abv_percent: 5,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Acme Brewing",
  country_of_origin: "USA",
} as unknown as DeclaredFields;

function makeItem(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: makeReviewItemId(),
    source: "single",
    enqueuedAt: Date.now(),
    declared: STUB_DECLARED,
    verifyResponse: STUB_RESPONSE,
    reasons: ["test reason"],
    ...overrides,
  };
}

beforeEach(() => {
  _resetReviewQueueForTests();
});

describe("review-queue: enqueue / dequeue (FIFO)", () => {
  it("dequeues in insertion order", () => {
    const a = makeItem({ filename: "a.png" });
    const b = makeItem({ filename: "b.png" });
    const c = makeItem({ filename: "c.png" });
    enqueueForReview(a);
    enqueueForReview(b);
    enqueueForReview(c);

    expect(dequeueForReview()?.filename).toBe("a.png");
    expect(dequeueForReview()?.filename).toBe("b.png");
    expect(dequeueForReview()?.filename).toBe("c.png");
    expect(dequeueForReview()).toBeUndefined();
  });

  it("de-dupes by id", () => {
    const a = makeItem({ id: "dup-1" });
    enqueueForReview(a);
    enqueueForReview(a);
    expect(getStats().pending).toBe(1);
  });
});

describe("review-queue: cap at MAX_QUEUE_SIZE", () => {
  it("evicts the oldest when over capacity", () => {
    // Push MAX + 5 items.
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) {
      enqueueForReview(makeItem({ filename: `f-${i}.png` }));
    }
    const stats = getStats();
    expect(stats.pending).toBe(MAX_QUEUE_SIZE);
    // The oldest five (f-0 … f-4) should have been evicted; the next dequeue
    // should be f-5.
    expect(dequeueForReview()?.filename).toBe("f-5.png");
  });
});

describe("review-queue: peek", () => {
  it("returns most-recent-first and respects the limit", () => {
    enqueueForReview(makeItem({ filename: "oldest.png" }));
    enqueueForReview(makeItem({ filename: "middle.png" }));
    enqueueForReview(makeItem({ filename: "newest.png" }));

    const peeked = peekQueue(2);
    expect(peeked.map((p) => p.filename)).toEqual(["newest.png", "middle.png"]);
  });

  it("returns all when no limit given", () => {
    enqueueForReview(makeItem({ filename: "x.png" }));
    enqueueForReview(makeItem({ filename: "y.png" }));
    expect(peekQueue()).toHaveLength(2);
  });
});

describe("review-queue: markResolved", () => {
  it("removes the item from the pending queue", () => {
    const a = makeItem({ filename: "a.png" });
    const b = makeItem({ filename: "b.png" });
    enqueueForReview(a);
    enqueueForReview(b);

    const ok = markResolved(a.id, {
      resolvedBy: "reviewer@example.com",
      verdict: "fail",
      notes: "Brand is wrong",
    });
    expect(ok).toBe(true);
    expect(getStats().pending).toBe(1);
    expect(peekQueue()[0]?.filename).toBe("b.png");
  });

  it("returns false for unknown ids", () => {
    expect(
      markResolved("does-not-exist", {
        resolvedBy: "x",
        verdict: "pass",
      }),
    ).toBe(false);
  });

  it("increments resolvedToday count", () => {
    const a = makeItem();
    enqueueForReview(a);
    markResolved(a.id, { resolvedBy: "x", verdict: "pass" });
    expect(getStats().resolvedToday).toBe(1);
  });
});

describe("review-queue: makeReviewItemId", () => {
  it("returns unique ids on consecutive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(makeReviewItemId());
    expect(ids.size).toBe(100);
  });
  it("ids are URL-safe", () => {
    const id = makeReviewItemId();
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
