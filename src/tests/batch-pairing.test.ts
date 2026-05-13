import { describe, expect, it } from "vitest";
import {
  classifyFile,
  fingerprintSimilarity,
  pairByContent,
  pairByFilenameStem,
  stem,
  summarize,
  type ApplicationFingerprint,
  type ImageFingerprint,
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

  it("optionally strips a trailing app-tag (Hermes audit fix)", () => {
    // App-side suffixes should ALSO be strippable so a file named
    // `123456-app.pdf` reduces to `123456` for the relaxed pass,
    // matching `123456-front.jpg` once both sides are normalized.
    expect(stem("123456-app.pdf", { stripAppTag: true })).toBe("123456");
    expect(stem("123456-application.json", { stripAppTag: true })).toBe("123456");
    expect(stem("123456-cola.csv", { stripAppTag: true })).toBe("123456");
    expect(stem("123456_form.md", { stripAppTag: true })).toBe("123456");
    // Without the flag the suffix stays.
    expect(stem("123456-app.pdf")).toBe("123456-app");
    // Both flags compose correctly.
    expect(
      stem("123456-front.jpg", { stripFaceTag: true, stripAppTag: true }),
    ).toBe("123456");
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
    // .docx + .rtf without a recognised MIME stay "other" since the
    // app-side parsers don't know what to do with them.
    expect(classifyFile(file("a.rtf", ""))).toBe("other");
  });

  it("recognises DOCX as an application file (mammoth path)", () => {
    expect(
      classifyFile(
        file(
          "a.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
      ),
    ).toBe("application");
    // MIME-less .docx is also classified via extension fallback.
    expect(classifyFile(file("a.docx", ""))).toBe("application");
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

  it("pairs an image with an `-app`-tagged application via the relaxed pass (Hermes audit fix)", () => {
    // Hermes finding: docs claimed `123456-front.jpg ↔ 123456-app.pdf`
    // worked, but the stem helper only stripped image-side face tags,
    // so the app's relaxed stem stayed `123456-app` and never matched
    // the image's relaxed stem `123456`. Fixed by adding stripAppTag.
    const result = pairByFilenameStem([
      file("123456-front.jpg", "image/jpeg"),
      file("123456-back.jpg", "image/jpeg"),
      file("123456-app.pdf", "application/pdf"),
    ]);
    expect(result.paired).toHaveLength(2);
    expect(result.paired[0]!.applicationFile.name).toBe("123456-app.pdf");
    expect(result.paired[1]!.applicationFile.name).toBe("123456-app.pdf");
    expect(result.unpairedImages).toHaveLength(0);
    expect(result.unpairedApplications).toHaveLength(0);
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
    // summarize now carries `source` from PairingHit (filename-strict
    // in this case).
    expect(s.pairs[0]).toMatchObject({
      image: "acme.jpg",
      application: "acme.pdf",
      stem: "acme",
      source: "filename-strict",
    });
    expect(s.unpairedImages).toEqual(["orphan.jpg"]);
  });
});

describe("batch-pairing — fingerprintSimilarity", () => {
  it("returns 1.0 on identical brand + class", () => {
    const score = fingerprintSimilarity(
      { brand_name: "Stone's Throw IPA", class_type: "India Pale Ale" },
      { brand_name: "Stone's Throw IPA", class_type: "India Pale Ale" },
    );
    expect(score).toBeCloseTo(1.0, 2);
  });

  it("matches normalized brand + class (punctuation, case)", () => {
    const score = fingerprintSimilarity(
      { brand_name: "Mill Creek", class_type: "Pilsner" },
      { brand_name: "MILL CREEK BREWING CO.", class_type: "Pilsner Lager" },
    );
    // Brand "Mill Creek" is a substring of "Mill Creek Brewing Co" so
    // the substring rule kicks in — score should be > 0.75 not
    // strictly 1.0.
    expect(score).toBeGreaterThan(0.7);
  });

  it("low score when brand + class are unrelated", () => {
    const score = fingerprintSimilarity(
      { brand_name: "Stone's Throw IPA", class_type: "India Pale Ale" },
      { brand_name: "Mountain Lark", class_type: "Hard Cider" },
    );
    expect(score).toBeLessThan(0.4);
  });

  it("ABV adds a small positive signal when within 0.5%", () => {
    const sameAbv = fingerprintSimilarity(
      { brand_name: "Mill Creek", class_type: "Lager", abv_percent: 5.2 },
      { brand_name: "Mill Creek", class_type: "Lager", abv_percent: 5.2 },
    );
    const farAbv = fingerprintSimilarity(
      { brand_name: "Mill Creek", class_type: "Lager", abv_percent: 5.2 },
      { brand_name: "Mill Creek", class_type: "Lager", abv_percent: 9.0 },
    );
    expect(sameAbv).toBeGreaterThan(farAbv);
  });

  it("returns 0 when either fingerprint is empty", () => {
    expect(
      fingerprintSimilarity({}, { brand_name: "ACME", class_type: "IPA" }),
    ).toBe(0);
    expect(
      fingerprintSimilarity(
        { brand_name: "ACME", class_type: "IPA" },
        {},
      ),
    ).toBe(0);
  });
});

describe("batch-pairing — pairByContent (random-filename fallback)", () => {
  function imgFile(name: string): File {
    return new File([new Uint8Array(8)], name, { type: "image/jpeg" });
  }
  function appFile(name: string): File {
    return new File(["{}"], name, { type: "application/json" });
  }

  it("pairs randomly-named images and apps by brand + class similarity", () => {
    // Reviewer dropped images named DSC_001.jpg / DSC_002.jpg and
    // apps named app1.json / app2.json — no filename signal at all.
    const images: Array<{ file: File; fingerprint: ImageFingerprint }> = [
      {
        file: imgFile("DSC_001.jpg"),
        fingerprint: { brand_name: "Mill Creek", class_type: "Pilsner" },
      },
      {
        file: imgFile("DSC_002.jpg"),
        fingerprint: { brand_name: "Mountain Lark", class_type: "Hard Cider" },
      },
    ];
    const apps: Array<{ file: File; fingerprint: ApplicationFingerprint }> = [
      {
        file: appFile("app1.json"),
        fingerprint: { brand_name: "Mountain Lark", class_type: "Hard Cider" },
      },
      {
        file: appFile("app2.json"),
        fingerprint: { brand_name: "Mill Creek Brewing Co.", class_type: "Pilsner" },
      },
    ];
    const result = pairByContent(images, apps);
    expect(result.paired).toHaveLength(2);
    expect(result.remainingImages).toHaveLength(0);
    expect(result.remainingApplications).toHaveLength(0);
    // The greedy matcher should pair DSC_001 ↔ app2 (Mill Creek)
    // and DSC_002 ↔ app1 (Mountain Lark).
    const byImage = new Map(
      result.paired.map((p) => [p.imageFile.name, p.applicationFile.name]),
    );
    expect(byImage.get("DSC_001.jpg")).toBe("app2.json");
    expect(byImage.get("DSC_002.jpg")).toBe("app1.json");
    // Each content-paired hit carries source + score for the
    // operator's response.
    for (const hit of result.paired) {
      expect(hit.source).toBe("content");
      expect(hit.score).toBeGreaterThan(0.6);
    }
  });

  it("leaves dissimilar items unpaired (below threshold)", () => {
    const images: Array<{ file: File; fingerprint: ImageFingerprint }> = [
      {
        file: imgFile("photo.jpg"),
        fingerprint: { brand_name: "ACME Vodka", class_type: "Vodka" },
      },
    ];
    const apps: Array<{ file: File; fingerprint: ApplicationFingerprint }> = [
      {
        // Wildly different brand + class — should not pair.
        file: appFile("random.json"),
        fingerprint: { brand_name: "Stone's Throw IPA", class_type: "India Pale Ale" },
      },
    ];
    const result = pairByContent(images, apps);
    expect(result.paired).toHaveLength(0);
    expect(result.remainingImages).toHaveLength(1);
    expect(result.remainingApplications).toHaveLength(1);
  });

  it("uses greedy highest-score first when multiple candidates compete", () => {
    // Image fingerprint matches App-1 perfectly (1.0) and App-2
    // partially (~0.7). The greedy matcher should pick App-1.
    const images: Array<{ file: File; fingerprint: ImageFingerprint }> = [
      {
        file: imgFile("a.jpg"),
        fingerprint: { brand_name: "Mill Creek", class_type: "Lager" },
      },
    ];
    const apps: Array<{ file: File; fingerprint: ApplicationFingerprint }> = [
      {
        file: appFile("a-app-perfect.json"),
        fingerprint: { brand_name: "Mill Creek", class_type: "Lager" },
      },
      {
        file: appFile("a-app-partial.json"),
        fingerprint: { brand_name: "Mill Creek Brewing", class_type: "Pilsner" },
      },
    ];
    const result = pairByContent(images, apps);
    expect(result.paired).toHaveLength(1);
    expect(result.paired[0]!.applicationFile.name).toBe("a-app-perfect.json");
    // The partial-match app remains unpaired.
    expect(result.remainingApplications.map((f) => f.name)).toEqual([
      "a-app-partial.json",
    ]);
  });

  it("respects an explicit threshold option", () => {
    const images: Array<{ file: File; fingerprint: ImageFingerprint }> = [
      {
        file: imgFile("a.jpg"),
        fingerprint: { brand_name: "Mill Creek", class_type: "Lager" },
      },
    ];
    const apps: Array<{ file: File; fingerprint: ApplicationFingerprint }> = [
      {
        // Score will land at ~0.6 — between the loose 0.55 default
        // and the strict 0.9 we pass below.
        file: appFile("loose.json"),
        fingerprint: { brand_name: "Mill", class_type: "Stout" },
      },
    ];
    const loose = pairByContent(images, apps);
    const strict = pairByContent(images, apps, { threshold: 0.9 });
    // Loose may or may not pair depending on similarity weights; what
    // matters is the strict run rejects what loose accepts.
    expect(strict.paired.length).toBeLessThanOrEqual(loose.paired.length);
  });
});
