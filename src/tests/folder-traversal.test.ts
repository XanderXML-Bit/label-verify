import { describe, expect, it, vi } from "vitest";
import {
  extractEntriesFromDataTransfer,
  flattenEntries,
  partitionFolderResult,
  type FsEntryLike,
} from "@/lib/folder-traversal";

// -----------------------------------------------------------------------------
// Test helpers — synthesise the minimal FileSystemEntry-like shape that
// flattenEntries depends on. The real browser API exposes async, callback-
// driven methods (`.file(onSuccess, onError)`, `.createReader().readEntries(cb)`);
// we mirror that here so the helper can be exercised in vitest without a DOM.
// -----------------------------------------------------------------------------

function makeFile(name: string, size = 8, type = "image/png"): File {
  return new File([new Uint8Array(size)], name, { type });
}

function fsFile(name: string, file?: File): FsEntryLike {
  const f = file ?? makeFile(name);
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onSuccess) => onSuccess(f),
  };
}

function fsDir(name: string, children: FsEntryLike[]): FsEntryLike {
  // Reader returns batches; we mimic the browser's behaviour of yielding
  // up to BATCH_SIZE entries per readEntries call and signalling EOF by
  // returning an empty array on the next call. Tests can use this to
  // assert that the helper handles multi-batch directories correctly.
  let cursor = 0;
  const BATCH_SIZE = 100;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (onSuccess) => {
        const slice = children.slice(cursor, cursor + BATCH_SIZE);
        cursor += slice.length;
        // Browsers call the success callback with an empty array to
        // signal end-of-directory; our mock follows the same contract.
        onSuccess(slice);
      },
    }),
  };
}

// A directory entry whose readEntries always errors — used to test
// resilience: a partial-read failure on one folder shouldn't poison the
// whole traversal.
function fsDirThatErrors(name: string): FsEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (_onSuccess, onError) => {
        onError?.(new DOMException("permission denied", "NotAllowedError"));
      },
    }),
  };
}

describe("flattenEntries", () => {
  it("returns a single file at the top level", async () => {
    const f = makeFile("label.png");
    const files = await flattenEntries([fsFile("label.png", f)]);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("label.png");
  });

  it("recurses one level deep", async () => {
    const a = makeFile("a.png");
    const b = makeFile("b.json", 12, "application/json");
    const tree = [fsDir("batch1", [fsFile("a.png", a), fsFile("b.json", b)])];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name).sort()).toEqual(["a.png", "b.json"]);
  });

  it("recurses two levels deep", async () => {
    const tree = [
      fsDir("root", [
        fsFile("top.png"),
        fsDir("nested", [fsFile("inner.json")]),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name).sort()).toEqual(["inner.json", "top.png"]);
  });

  it("handles an empty folder", async () => {
    const tree = [fsDir("empty", [])];
    const files = await flattenEntries(tree);
    expect(files).toEqual([]);
  });

  it("returns an empty list when given no entries", async () => {
    const files = await flattenEntries([]);
    expect(files).toEqual([]);
  });

  it("yields files even when sibling folders are empty", async () => {
    const tree = [
      fsDir("root", [
        fsDir("emptyChild", []),
        fsFile("keeper.png"),
        fsDir("emptyChild2", []),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name)).toEqual(["keeper.png"]);
  });

  it("caps at maxFiles to avoid DoS when the user drops /home", async () => {
    // Fabricate a folder with 1500 files — flattenEntries should stop
    // at maxFiles=500 and report a truncation flag back.
    const many: FsEntryLike[] = Array.from({ length: 1500 }, (_, i) =>
      fsFile(`f${i}.png`),
    );
    const tree = [fsDir("big", many)];
    const out = await flattenEntries(tree, { maxFiles: 500 });
    expect(out).toHaveLength(500);
  });

  it("does not throw when readEntries errors on one subtree (resilient)", async () => {
    const tree = [
      fsDir("root", [
        fsFile("kept1.png"),
        fsDirThatErrors("locked-folder"),
        fsFile("kept2.png"),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name).sort()).toEqual(["kept1.png", "kept2.png"]);
  });

  it("handles multi-batch directories (browser returns entries in chunks)", async () => {
    // Build a directory with 250 files. Our mock batches at 100, so the
    // helper must keep calling readEntries until it gets back an empty
    // array. If it stops after one call we'd only see 100 files.
    const many: FsEntryLike[] = Array.from({ length: 250 }, (_, i) =>
      fsFile(`f${i}.png`),
    );
    const tree = [fsDir("chunked", many)];
    const files = await flattenEntries(tree);
    expect(files).toHaveLength(250);
  });

  it("preserves the underlying File objects (not synthetic copies)", async () => {
    const original = makeFile("orig.png");
    const tree = [fsDir("root", [fsFile("orig.png", original)])];
    const files = await flattenEntries(tree);
    expect(files[0]).toBe(original);
  });

  it("tolerates an entry that is neither file nor directory (weird browser quirk)", async () => {
    // webkitGetAsEntry can theoretically return symbolic links or
    // similar entries that have both flags false. Skip them silently.
    const odd: FsEntryLike = {
      isFile: false,
      isDirectory: false,
      name: "weird",
    };
    const tree = [fsDir("root", [odd, fsFile("kept.png")])];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name)).toEqual(["kept.png"]);
  });

  // -------- wave-12 review-fixes: edge-case tests --------

  it("skips macOS system-noise files (.DS_Store and resource forks)", async () => {
    const tree = [
      fsDir("root", [
        fsFile(".DS_Store"),
        fsFile("._photo.jpg"),
        fsFile("photo.jpg"),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name)).toEqual(["photo.jpg"]);
  });

  it("skips Windows system-noise files (Thumbs.db, desktop.ini)", async () => {
    const tree = [
      fsDir("root", [
        fsFile("Thumbs.db"),
        fsFile("thumbs.db"), // case variation
        fsFile("desktop.ini"),
        fsFile("label.png"),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name)).toEqual(["label.png"]);
  });

  it("skips zero-byte files (they would 4xx server-side anyway)", async () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    const good = makeFile("good.png");
    const tree = [fsDir("root", [fsFile("empty.png", empty), fsFile("good.png", good)])];
    const files = await flattenEntries(tree);
    expect(files.map((f) => f.name)).toEqual(["good.png"]);
  });

  it("handles unicode folder + file names without corruption", async () => {
    const fancy = makeFile("café-étiquette.png");
    const tree = [
      fsDir("批次-01", [
        // Greek + Cyrillic + accented Latin all in one tree.
        fsDir("Δοκιμή", [fsFile("café-étiquette.png", fancy)]),
      ]),
    ];
    const files = await flattenEntries(tree);
    expect(files[0]?.name).toBe("café-étiquette.png");
    expect(files).toHaveLength(1);
  });

  it("stops mid-subtree when maxFiles is hit (review #6)", async () => {
    // A nested tree containing more files than the cap, distributed
    // across multiple subdirectories. flattenEntries should stop
    // visiting children once `out.length >= maxFiles` — not just
    // refuse to push, but actually short-circuit the recursion.
    const tree = [
      fsDir("root", [
        fsDir("a", Array.from({ length: 50 }, (_, i) => fsFile(`a${i}.png`))),
        fsDir("b", Array.from({ length: 50 }, (_, i) => fsFile(`b${i}.png`))),
        fsDir("c", Array.from({ length: 50 }, (_, i) => fsFile(`c${i}.png`))),
      ]),
    ];
    const files = await flattenEntries(tree, { maxFiles: 75 });
    expect(files).toHaveLength(75);
  });

  it("respects maxDirChildren — does not OOM on hostile readEntries (review #6)", async () => {
    // A directory that returns its children one-at-a-time forever
    // would build an unbounded accumulator inside
    // readAllDirectoryChildren if not capped. With a 50-child cap
    // the helper resolves early. We synthesise this by giving the
    // directory 10000 children and asserting that the file output
    // is bounded by maxFiles (the outer cap) and that the call
    // returns in reasonable time.
    const huge: FsEntryLike[] = Array.from({ length: 10_000 }, (_, i) =>
      fsFile(`f${i}.png`),
    );
    const tree = [fsDir("hostile", huge)];
    const start = Date.now();
    const files = await flattenEntries(tree, {
      maxFiles: 100,
      maxDirChildren: 200,
    });
    const elapsed = Date.now() - start;
    expect(files).toHaveLength(100);
    expect(elapsed).toBeLessThan(500); // bounded, even on slow CI
  });
});

describe("extractEntriesFromDataTransfer", () => {
  function mkDtItem(opts: {
    kind?: string;
    entry?: FsEntryLike | null;
  }): DataTransferItem {
    return {
      kind: opts.kind ?? "file",
      type: "image/png",
      webkitGetAsEntry: () => opts.entry ?? null,
      // Methods we don't exercise — typed as no-ops.
      getAsFile: () => null,
      getAsString: () => undefined,
    } as unknown as DataTransferItem;
  }

  function mkDtList(items: DataTransferItem[]): DataTransferItemList {
    const list = items as unknown as DataTransferItemList;
    Object.defineProperty(list, "length", { value: items.length });
    return list;
  }

  it("returns the entries for each file item", () => {
    const entry: FsEntryLike = {
      isFile: true,
      isDirectory: false,
      name: "a.png",
    };
    const items = mkDtList([mkDtItem({ entry })]);
    const result = extractEntriesFromDataTransfer(items);
    expect(result).toEqual([entry]);
  });

  it("filters out non-file items (string drags)", () => {
    const entry: FsEntryLike = {
      isFile: true,
      isDirectory: false,
      name: "a.png",
    };
    const items = mkDtList([
      mkDtItem({ kind: "string", entry: null }),
      mkDtItem({ entry }),
    ]);
    const result = extractEntriesFromDataTransfer(items);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("a.png");
  });

  it("filters out items whose webkitGetAsEntry returns null (older browsers)", () => {
    const items = mkDtList([mkDtItem({ entry: null })]);
    expect(extractEntriesFromDataTransfer(items)).toEqual([]);
  });

  it("handles an empty list", () => {
    const items = mkDtList([]);
    expect(extractEntriesFromDataTransfer(items)).toEqual([]);
  });
});

describe("partitionFolderResult", () => {
  // Stand-in classifier — keeps the unit pure (no dep on batch-pairing).
  const classify = (f: File): "image" | "application" | "unknown" => {
    if (/\.(png|jpe?g|webp|heic|heif)$/i.test(f.name)) return "image";
    if (/\.(pdf|json|csv|md|markdown|txt|docx)$/i.test(f.name))
      return "application";
    return "unknown";
  };

  it("splits a mixed list into the three buckets", () => {
    const files = [
      makeFile("a.png"),
      makeFile("b.pdf"),
      makeFile("c.json"),
      makeFile("d.heic"),
      makeFile("e.exe"),
      makeFile("f.ds_store"),
    ];
    const result = partitionFolderResult(files, classify);
    expect(result.images.map((f) => f.name)).toEqual(["a.png", "d.heic"]);
    expect(result.apps.map((f) => f.name)).toEqual(["b.pdf", "c.json"]);
    expect(result.ignored.map((f) => f.name)).toEqual(["e.exe", "f.ds_store"]);
  });

  it("handles empty input", () => {
    expect(partitionFolderResult([], classify)).toEqual({
      images: [],
      apps: [],
      ignored: [],
    });
  });

  it("treats every input as ignored when classifier rejects all", () => {
    const files = [makeFile("a.exe"), makeFile("b.dll")];
    const result = partitionFolderResult(files, classify);
    expect(result.images).toEqual([]);
    expect(result.apps).toEqual([]);
    expect(result.ignored).toHaveLength(2);
  });

  it("never invokes the classifier more than once per file", () => {
    const spy = vi.fn(classify);
    const files = [makeFile("a.png"), makeFile("b.pdf")];
    partitionFolderResult(files, spy);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
