import { describe, expect, it } from "vitest";
import {
  detectCsvManifestShape,
  detectJsonManifestShape,
} from "@/lib/application/detect-manifest";

describe("detectCsvManifestShape", () => {
  it("single-row CSV → kind: single-row", () => {
    const shape = detectCsvManifestShape(
      "brand_name,class_type,abv_percent\nStone's Throw IPA,IPA,6.4",
    );
    expect(shape.kind).toBe("single-row");
    if (shape.kind === "single-row") {
      expect(shape.rows[0]!.brand_name).toBe("Stone's Throw IPA");
    }
  });

  it("multi-row CSV with filename column → kind: multi-row + hasFilenameColumn", () => {
    const shape = detectCsvManifestShape(
      `filename,brand_name,class_type,abv_percent
label-001.jpg,Stone's Throw IPA,IPA,6.4
label-002.jpg,Mill Creek Pilsner,Pilsner,5.2
label-003.jpg,Mountain Lark Cider,Hard Cider,6.0`,
    );
    expect(shape.kind).toBe("multi-row");
    if (shape.kind === "multi-row") {
      expect(shape.rows).toHaveLength(3);
      expect(shape.hasFilenameColumn).toBe(true);
      expect(shape.filenameColumn).toBe("filename");
    }
  });

  it("multi-row CSV WITHOUT filename column → multi-row + hasFilenameColumn: false", () => {
    const shape = detectCsvManifestShape(
      `brand_name,class_type
Stone's Throw IPA,IPA
Mill Creek Pilsner,Pilsner`,
    );
    expect(shape.kind).toBe("multi-row");
    if (shape.kind === "multi-row") {
      expect(shape.hasFilenameColumn).toBe(false);
      expect(shape.filenameColumn).toBeNull();
    }
  });

  it("recognises alias filename columns (image, label, cola_number)", () => {
    for (const col of ["image", "label", "cola_number", "Image", "COLA_Number"]) {
      const shape = detectCsvManifestShape(
        `${col},brand_name\nfoo.jpg,Brand A\nbar.jpg,Brand B`,
      );
      expect(shape.kind).toBe("multi-row");
      if (shape.kind === "multi-row") {
        expect(shape.hasFilenameColumn).toBe(true);
        expect(shape.filenameColumn).toBe(col);
      }
    }
  });

  it("empty CSV → unparseable", () => {
    const shape = detectCsvManifestShape("");
    expect(shape.kind).toBe("unparseable");
  });

  it("malformed CSV (unclosed quote) → unparseable", () => {
    const shape = detectCsvManifestShape(
      `brand_name,class_type\n"unclosed,IPA\nrow2,wine`,
    );
    expect(shape.kind).toBe("unparseable");
  });
});

describe("detectJsonManifestShape", () => {
  it("single object → kind: single-row", () => {
    const shape = detectJsonManifestShape(
      '{"brand_name":"Stone\'s Throw IPA","class_type":"IPA","abv_percent":6.4}',
    );
    expect(shape.kind).toBe("single-row");
    if (shape.kind === "single-row") {
      expect(shape.rows[0]!.brand_name).toBe("Stone's Throw IPA");
    }
  });

  it("array of length 1 → kind: single-row", () => {
    const shape = detectJsonManifestShape(
      '[{"brand_name":"Stone\'s Throw IPA","class_type":"IPA"}]',
    );
    expect(shape.kind).toBe("single-row");
  });

  it("array of length > 1 → kind: multi-row", () => {
    const shape = detectJsonManifestShape(
      `[{"filename":"a.jpg","brand_name":"A"},{"filename":"b.jpg","brand_name":"B"},{"filename":"c.jpg","brand_name":"C"}]`,
    );
    expect(shape.kind).toBe("multi-row");
    if (shape.kind === "multi-row") {
      expect(shape.rows).toHaveLength(3);
      expect(shape.hasFilenameColumn).toBe(true);
      expect(shape.filenameColumn).toBe("filename");
    }
  });

  it("multi-row JSON without filename → hasFilenameColumn: false", () => {
    const shape = detectJsonManifestShape(
      `[{"brand_name":"A"},{"brand_name":"B"}]`,
    );
    expect(shape.kind).toBe("multi-row");
    if (shape.kind === "multi-row") {
      expect(shape.hasFilenameColumn).toBe(false);
    }
  });

  it("empty array → unparseable", () => {
    const shape = detectJsonManifestShape("[]");
    expect(shape.kind).toBe("unparseable");
  });

  it("malformed JSON → unparseable", () => {
    const shape = detectJsonManifestShape("{not json");
    expect(shape.kind).toBe("unparseable");
  });

  it("nested net_contents flattens for downstream rowToDeclared", () => {
    const shape = detectJsonManifestShape(
      `{"brand_name":"X","net_contents":{"value":12,"unit":"fl_oz"}}`,
    );
    expect(shape.kind).toBe("single-row");
    if (shape.kind === "single-row") {
      // Both flat-style and nested-style fields are present.
      expect(shape.rows[0]!.net_contents).toBe("12 fl_oz");
    }
  });
});
