import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  fileIdentityKey,
  mergeFilesForRestage,
  isLikelyIos,
} from "@/lib/upload-merge";

function makeFile(
  name: string,
  body = "x",
  lastModified = 1_700_000_000_000,
): File {
  // The `type` field is allowed to vary because the dedupe is
  // intentionally type-agnostic (browsers report MIME inconsistently).
  return new File([body], name, { type: "image/png", lastModified });
}

describe("fileIdentityKey", () => {
  it("includes name + size + lastModified", () => {
    const f = makeFile("a.png", "abc", 12345);
    expect(fileIdentityKey(f)).toBe("a.png::3::12345");
  });

  it("differs on different names with same body + timestamp", () => {
    const a = makeFile("a.png", "abc", 12345);
    const b = makeFile("b.png", "abc", 12345);
    expect(fileIdentityKey(a)).not.toBe(fileIdentityKey(b));
  });

  it("ignores MIME type — same name+size+mtime maps to same key", () => {
    const a = new File(["abc"], "a.png", { type: "image/png", lastModified: 1 });
    const b = new File(["abc"], "a.png", { type: "image/heic", lastModified: 1 });
    expect(fileIdentityKey(a)).toBe(fileIdentityKey(b));
  });
});

describe("mergeFilesForRestage", () => {
  it("returns a single deduped list when adding new files", () => {
    const a = makeFile("a.png", "1", 1);
    const b = makeFile("b.png", "2", 2);
    const c = makeFile("c.png", "3", 3);
    const merged = mergeFilesForRestage([a, b], [c]);
    expect(merged.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("preserves order: existing first, then new", () => {
    const a = makeFile("a.png", "1", 1);
    const b = makeFile("b.png", "2", 2);
    const c = makeFile("c.png", "3", 3);
    const merged = mergeFilesForRestage([a], [b, c]);
    expect(merged.map((f) => f.name)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("dedupes when the user re-picks an already-staged file (iOS habit)", () => {
    const a = makeFile("photo.jpg", "data", 1_700_000_000_000);
    const aAgain = makeFile("photo.jpg", "data", 1_700_000_000_000);
    const b = makeFile("photo2.jpg", "data", 1_700_000_000_001);
    const merged = mergeFilesForRestage([a], [aAgain, b]);
    expect(merged.length).toBe(2);
    expect(merged[0]).toBe(a); // original instance, not the duplicate
    expect(merged[1]?.name).toBe("photo2.jpg");
  });

  it("treats different timestamps as different files", () => {
    // Two photos taken at slightly different moments are different
    // photos, even if the user happens to have named them identically.
    const a = makeFile("img.jpg", "data", 1_700_000_000_000);
    const b = makeFile("img.jpg", "data", 1_700_000_001_000);
    const merged = mergeFilesForRestage([a], [b]);
    expect(merged.length).toBe(2);
  });

  it("dedupes within the new list too (defensive)", () => {
    const a = makeFile("a.png", "1", 1);
    const aAgain = makeFile("a.png", "1", 1);
    const merged = mergeFilesForRestage([], [a, aAgain]);
    expect(merged.length).toBe(1);
  });

  it("returns empty when both inputs are empty", () => {
    expect(mergeFilesForRestage([], [])).toEqual([]);
  });

  it("does not mutate the input arrays", () => {
    const a = makeFile("a.png", "1", 1);
    const current = [a];
    const additional = [makeFile("b.png", "2", 2)];
    mergeFilesForRestage(current, additional);
    expect(current.length).toBe(1);
    expect(additional.length).toBe(1);
  });
});

describe("isLikelyIos", () => {
  const originalNavigator = globalThis.navigator;
  beforeEach(() => {
    vi.stubGlobal("navigator", undefined);
  });
  afterEach(() => {
    vi.stubGlobal("navigator", originalNavigator);
  });

  it("returns false when navigator is undefined (SSR-safe)", () => {
    expect(isLikelyIos()).toBe(false);
  });

  it("detects iPhone UA", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      maxTouchPoints: 5,
    } as Navigator);
    expect(isLikelyIos()).toBe(true);
  });

  it("detects iPad masquerading as macOS Safari (iPadOS 13+)", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      maxTouchPoints: 5,
    } as Navigator);
    expect(isLikelyIos()).toBe(true);
  });

  it("returns false for a real desktop Mac (no touch)", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      maxTouchPoints: 0,
    } as Navigator);
    expect(isLikelyIos()).toBe(false);
  });

  it("returns false for desktop Chrome", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      maxTouchPoints: 0,
    } as Navigator);
    expect(isLikelyIos()).toBe(false);
  });

  it("returns false for Android Chrome (touch but not iOS)", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      maxTouchPoints: 5,
    } as Navigator);
    expect(isLikelyIos()).toBe(false);
  });
});
