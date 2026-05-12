import { describe, expect, it } from "vitest";
import {
  createBatch,
  getBatch,
  setItemResult,
  setItemError,
  deleteBatch,
  type BatchItem,
} from "@/lib/batch-store";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";

const DECLARED: DeclaredFields = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

function makeItem(index: number, filename: string): Omit<BatchItem, "status"> {
  return {
    index,
    filename,
    imageBytes: Buffer.from([0xff, 0xd8, 0xff]),
    mime: "image/jpeg",
    declared: DECLARED,
  };
}

function fakeResult(verdict: "pass" | "fail" | "review" = "pass"): VerifyResponse {
  return {
    verdict,
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: 1, vision: 1, matching: 1, total: 4 },
    modelId: "mock",
    modelVersion: "mock-v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

describe("batch-store", () => {
  it("createBatch returns a UUID and pending items", () => {
    const job = createBatch([makeItem(0, "a.jpg"), makeItem(1, "b.jpg")]);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.items).toHaveLength(2);
    expect(job.items.every((it) => it.status === "pending")).toBe(true);
    expect(job.doneCount).toBe(0);
  });

  it("createBatch ids are unique across calls", () => {
    const a = createBatch([makeItem(0, "a.jpg")]);
    const b = createBatch([makeItem(0, "b.jpg")]);
    expect(a.id).not.toBe(b.id);
  });

  it("getBatch retrieves by id and returns undefined for a missing id", () => {
    const job = createBatch([makeItem(0, "x.jpg")]);
    expect(getBatch(job.id)).toBe(job);
    expect(getBatch("not-a-real-id")).toBeUndefined();
  });

  it("setItemResult updates the correct item and bumps doneCount", () => {
    const job = createBatch([makeItem(0, "a.jpg"), makeItem(1, "b.jpg")]);
    const result = fakeResult("pass");
    setItemResult(job, 1, result);
    expect(job.items[0]!.status).toBe("pending");
    expect(job.items[1]!.status).toBe("done");
    expect(job.items[1]!.result).toBe(result);
    expect(job.doneCount).toBe(1);
  });

  it("setItemError marks errored and bumps doneCount", () => {
    const job = createBatch([makeItem(0, "a.jpg")]);
    setItemError(job, 0, "extractor exploded");
    expect(job.items[0]!.status).toBe("error");
    expect(job.items[0]!.error).toBe("extractor exploded");
    expect(job.doneCount).toBe(1);
  });

  it("set* on an out-of-range index is a no-op (no throw, no doneCount bump)", () => {
    const job = createBatch([makeItem(0, "a.jpg")]);
    setItemResult(job, 99, fakeResult());
    setItemError(job, 99, "nope");
    expect(job.doneCount).toBe(0);
  });

  it("deleteBatch removes the entry from the store", () => {
    const job = createBatch([makeItem(0, "a.jpg")]);
    expect(getBatch(job.id)).toBeDefined();
    deleteBatch(job.id);
    expect(getBatch(job.id)).toBeUndefined();
  });

  it("evicts the oldest batch when MAX_BATCHES (32) is exceeded", async () => {
    // Drain anything left from prior tests with a unique sentinel so we can
    // identify our own first insert.
    const first = createBatch([makeItem(0, "first.jpg")]);
    // The store has space for 32 jobs in total. Push 32 more new jobs; the
    // first one we created must be evicted because it is the oldest.
    for (let i = 0; i < 32; i++) {
      createBatch([makeItem(0, `n${i}.jpg`)]);
    }
    expect(getBatch(first.id)).toBeUndefined();
  });
});
