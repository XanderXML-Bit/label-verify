import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DeclaredFields, VerifyResponse } from "@/lib/types";

const verifyLabelMock = vi.fn();
vi.mock("@/lib/verify", () => ({
  verifyLabel: (...args: unknown[]) => verifyLabelMock(...args),
}));

import { GET } from "@/app/api/verify/batch/[id]/stream/route";
import {
  claimBatchProcessing,
  createBatch,
  getBatch,
  releaseBatchProcessing,
  setItemResult,
  type BatchItem,
} from "@/lib/batch-store";

const DECLARED: DeclaredFields = {
  brand_name: "Stone's Throw",
  class_type: "Pale Ale",
  class_category: "beer",
  abv_percent: 6.4,
  net_contents: { value: 12, unit: "fl_oz" },
  producer: "Stone's Throw Brewing Co.",
  country_of_origin: "USA",
};

function fakeResult(verdict: "pass" | "fail" | "review" = "pass"): VerifyResponse {
  return {
    verdict,
    imageQuality: "good",
    fields: {} as VerifyResponse["fields"],
    governmentWarning: {} as VerifyResponse["governmentWarning"],
    extracted: {} as VerifyResponse["extracted"],
    timings: { preprocess: 1, ocr: null, vision: 1, matching: 1, total: 3 },
    modelId: "mock",
    modelVersion: "mock-v1",
    modeUsed: "default",
    requiresHumanReview: false,
    reviewReasons: [],
  };
}

function makeItem(index: number, filename: string): Omit<BatchItem, "status"> {
  return {
    index,
    filename,
    imageBytes: Buffer.from([0xff, 0xd8, 0xff]),
    mime: "image/jpeg",
    declared: DECLARED,
  };
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function streamText(resp: Response): Promise<string> {
  return await resp.text();
}

describe("/api/verify/batch/[id]/stream", () => {
  beforeEach(() => {
    verifyLabelMock.mockReset();
    verifyLabelMock.mockResolvedValue(fakeResult("pass"));
  });

  it("rejects a second processor while a batch is already locked", async () => {
    const job = createBatch([makeItem(0, "a.jpg")]);
    expect(claimBatchProcessing(job)).toBe(true);
    try {
      const resp = await GET(new Request("http://test.local/stream"), ctx(job.id));
      expect(resp.status).toBe(409);
      expect(await resp.text()).toMatch(/already processing/i);
      expect(verifyLabelMock).not.toHaveBeenCalled();
    } finally {
      releaseBatchProcessing(job);
    }
  });

  it("skips completed items on reconnect and processes only pending work", async () => {
    const job = createBatch([makeItem(0, "done.jpg"), makeItem(1, "pending.jpg")]);
    setItemResult(job, 0, fakeResult("pass"));

    const resp = await GET(new Request("http://test.local/stream"), ctx(job.id));
    expect(resp.status).toBe(200);
    const text = await streamText(resp);

    expect(verifyLabelMock).toHaveBeenCalledTimes(1);
    expect(verifyLabelMock.mock.calls[0]?.[1]).toEqual(DECLARED);
    expect(text).toContain("event: start");
    expect(text).toContain('"index":1');
    expect(text).not.toContain('"index":0');
    expect(text).toContain("event: done");
  });

  it("deletes the batch from memory after a complete terminal stream", async () => {
    const job = createBatch([makeItem(0, "a.jpg")]);
    const resp = await GET(new Request("http://test.local/stream"), ctx(job.id));
    expect(resp.status).toBe(200);
    await streamText(resp);
    expect(getBatch(job.id)).toBeUndefined();
  });
});
