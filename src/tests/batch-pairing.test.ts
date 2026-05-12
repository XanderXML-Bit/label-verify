import { describe, expect, it } from "vitest";
import {
  classifyFile,
  pairByFilenameStem,
  stem,
  summarize,
} from "@/lib/batch-pairing";

function file(name: string, type: string, body = "x"): File {
  return new File([body], name, { type });
}

describe("batch-pairing — stem helper", () => {
  it("lowercases + strips path + strips extension", () => {
    expect(stem("ACME-Vodka.JPG")).toBe("acme-vodka");
    expect(stem("subdir\\Mill_Creek-front.png")).toBe("mill_creek-front");
    expect(stem("a/b/c.pdf")).toBe("c");
  });

  it("optionally strips a trailing face-tag", () => {
    expect(stem("123456-front.jpg", { stripFaceTag: true })).toBe("123456");
    expect(stem("123456-back.jpg", { stripFaceTag: true })).toBe("123456");
    expect(stem("123456-label.jpg", { stripFaceTag: true })).toBe("123456");
    // Without the flag the tag stays.
    expect(stem("123456-front.jpg")).toBe("123456-front");
  });
});

describe("batch-pairing — classifyFile", () => {
  it("recognises image MIMEs", () => {
    expect(classifyFile(file("a.jpg", "image/jpeg"))).toBe("image");
    expect(classifyFile(file("a.png", "image/png"))).toBe("image");
    expect(classifyFile(file("a.webp", "image/webp"))).toBe("image");
  });

  it("recognises application MIMEs", () => {
    expect(classifyFile(file("a.pdf", "application/pdf"))).toBe("application");
    expect(classifyFile(file("a.json", "application/json"))).toBe("application");
    expect(classifyFile(file("a.csv", "text/csv"))).toBe("application");
  });

  it("falls back to extension when MIME is missing / generic", () => {
    expect(classifyFile(file("a.pdf", ""))).toBe("application");
    expect(classifyFile(file("a.jpg", "application/octet-stream"))).toBe("image");
    expect(classifyFile(file("a.md", ""))).toBe("application");
  });

  it("returns 'other' for unsupported types", () => {
    expect(classifyFile(file("a.zip", "application/zip"))).toBe("other");
    expect(classifyFile(file("a.docx", ""))).toBe("other");
  });
});

describe("batch-pairing — pairByFilenameStem", () => {
  it("pairs files whose stems match (case- and extension-insensitive)", () => {
    const result = pairByFilenameStem([
      file("acme.jpg", "image/jpeg"),
      file("ACME.pdf", "application/pdf"),
      file("mill-creek.png", "image/png"),
      file("Mill-Creek.json", "application/json"),
    ]);
    expect(result.paired).toHaveLength(2);
    expect(result.unpairedImages).toHaveLength(0);
    expect(result.unpairedApplications).toHaveLength(0);
    const stems = result.paired.map((p) => p.stem).sort();
    expect(stems).toEqual(["acme", "mill-creek"]);
  });

  it("uses the relaxed face-tag-stripped match as a fallback", () => {
    // Two faces of the same bottle, one shared application file.
    const result = pairByFilenameStem([
      file("123456-front.jpg", "image/jpeg"),
      file("123456-back.jpg", "image/jpeg"),
      file("123456.pdf", "application/pdf"),
    ]);
    // Both images should pair with the same application file via the
    // face-tag-stripped pass.
    expect(result.paired).toHaveLength(2);
    expect(result.paired[0]!.applicationFile.name).toBe("123456.pdf");
    expect(result.paired[1]!.applicationFile.name).toBe("123456.pdf");
    expect(result.unpairedImages).toHaveLength(0);
  });

  it("prefers a strict-stem match over a face-tag-stripped one", () => {
    // Strict: front.jpg ↔ front.pdf; back.jpg has nothing strict, falls
    // to relaxed → matches back.pdf via stripped stem.
    const result = pairByFilenameStem([
      file("123456-front.jpg", "image/jpeg"),
      file("123456-back.jpg", "image/jpeg"),
      file("123456-front.pdf", "application/pdf"),
      file("123456-back.pdf", "application/pdf"),
    ]);
    expect(result.paired).toHaveLength(2);
    const byImage = new Map(
      result.paired.map((p) => [p.imageFile.name, p.applicationFile.name]),
    );
    expect(byImage.get("123456-front.jpg")).toBe("123456-front.pdf");
    expect(byImage.get("123456-back.jpg")).toBe("123456-back.pdf");
  });

  it("reports unpaired images and applications when stems don't line up", () => {
    const result = pairByFilenameStem([
      file("acme.jpg", "image/jpeg"),
      file("orphan.pdf", "application/pdf"),
    ]);
    expect(result.paired).toHaveLength(0);
    expect(result.unpairedImages.map((f) => f.name)).toEqual(["acme.jpg"]);
    expect(result.unpairedApplications.map((f) => f.name)).toEqual(["orphan.pdf"]);
  });

  it("buckets other-type files into 'ignored'", () => {
    const result = pairByFilenameStem([
      file("acme.jpg", "image/jpeg"),
      file("acme.pdf", "application/pdf"),
      file("notes.zip", "application/zip"),
    ]);
    expect(result.paired).toHaveLength(1);
    expect(result.ignored.map((f) => f.name)).toEqual(["notes.zip"]);
  });

  it("doesn't double-bind an application file to two unrelated images on the strict pass", () => {
    // Two images with distinct strict stems share an application.
    // Only one strict match wins; the other falls to relaxed and gets
    // unpaired (no relaxed match either).
    const result = pairByFilenameStem([
      file("acme.jpg", "image/jpeg"),
      file("other.jpg", "image/jpeg"),
      file("acme.pdf", "application/pdf"),
    ]);
    expect(result.paired).toHaveLength(1);
    expect(result.paired[0]!.imageFile.name).toBe("acme.jpg");
    expect(result.unpairedImages.map((f) => f.name)).toEqual(["other.jpg"]);
  });
});

describe("batch-pairing — summarize", () => {
  it("emits a reviewer-readable summary", () => {
    const result = pairByFilenameStem([
      file("acme.jpg", "image/jpeg"),
      file("acme.pdf", "application/pdf"),
      file("orphan.jpg", "image/jpeg"),
    ]);
    const s = summarize(result, "auto-stem");
    expect(s.mode).toBe("auto-stem");
    expect(s.pairedCount).toBe(1);
    expect(s.totalItems).toBe(1);
    expect(s.pairs).toEqual([
      { image: "acme.jpg", application: "acme.pdf", stem: "acme" },
    ]);
    expect(s.unpairedImages).toEqual(["orphan.jpg"]);
  });
});
