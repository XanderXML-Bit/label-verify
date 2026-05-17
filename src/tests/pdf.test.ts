import { describe, expect, it } from "vitest";
import {
  PdfExtractError,
  extractPdfFirstPage,
  extractPdfText,
} from "@/lib/pdf";

// ─── Minimal valid 1-page PDF ───────────────────────────────────────────────
// Hand-rolled to keep the test suite dependency-free (no pdf-lib needed).
// Structure: catalog → pages → one empty 612x792 page, plus xref + trailer.
// This is the smallest shape pdfjs-dist will load without throwing
// InvalidPDFException.
function minimalPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 8 >>\nstream\nBT ET\n\nendstream\nendobj\n",
  ];

  const header = "%PDF-1.4\n%\xC2\xA5\xC2\xB1\xC3\xAB\n";
  let body = header;
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, "binary"));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, "binary");
  body += "xref\n0 5\n";
  body += "0000000000 65535 f \n";
  for (const off of offsets) {
    body += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  body += "trailer\n<< /Size 5 /Root 1 0 R >>\n";
  body += `startxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(body, "binary");
}

describe("extractPdfFirstPage", () => {
  it("renders a minimal 1-page PDF to a PNG buffer", async () => {
    const pdf = minimalPdf();
    const result = await extractPdfFirstPage(pdf);
    expect(result.pageCount).toBe(1);
    expect(result.pngBuffer.length).toBeGreaterThan(0);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(result.pngBuffer.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
  });

  it("rejects a corrupt PDF with PdfExtractError code 'render-failed'", async () => {
    const garbage = Buffer.from("not actually a pdf, just some bytes");
    await expect(extractPdfFirstPage(garbage)).rejects.toBeInstanceOf(
      PdfExtractError,
    );
    try {
      await extractPdfFirstPage(garbage);
    } catch (err) {
      expect(err).toBeInstanceOf(PdfExtractError);
      expect((err as PdfExtractError).code).toBe("render-failed");
    }
  });

  it("rejects PDFs over the 20MB cap with code 'too-large'", async () => {
    const oversize = Buffer.alloc(21 * 1024 * 1024, 0x20);
    // Stamp a PDF header so it would otherwise look plausible — the size
    // gate must trip before parsing.
    oversize.write("%PDF-1.4\n", 0, "binary");
    await expect(extractPdfFirstPage(oversize)).rejects.toMatchObject({
      code: "too-large",
    });
  });
});

// Wave-33 coverage push: pdf.ts dropped to 53 % at audit time. Add
// the text-extraction path + error envelope shape to cover the
// `extractPdfText` half of the module.
describe("extractPdfText", () => {
  it("returns an empty text result on a content-stream-only PDF (no extractable text)", async () => {
    const pdf = minimalPdf();
    const result = await extractPdfText(pdf);
    // minimalPdf renders an EMPTY content stream — no text operators.
    // The extractor should return an empty / whitespace-only string,
    // not throw.
    expect(typeof result.text).toBe("string");
    expect(result.pageCount).toBe(1);
  });

  it("respects the same too-large gate as extractPdfFirstPage", async () => {
    const oversize = Buffer.alloc(21 * 1024 * 1024, 0x20);
    oversize.write("%PDF-1.4\n", 0, "binary");
    await expect(extractPdfText(oversize)).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("returns render-failed on a corrupt PDF", async () => {
    const garbage = Buffer.from("not a pdf");
    await expect(extractPdfText(garbage)).rejects.toBeInstanceOf(
      PdfExtractError,
    );
    try {
      await extractPdfText(garbage);
    } catch (err) {
      expect((err as PdfExtractError).code).toBe("render-failed");
    }
  });
});

describe("PdfExtractError shape", () => {
  it("preserves the original error name and message", () => {
    const err = new PdfExtractError("encrypted", "PDF is locked");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PdfExtractError);
    expect(err.name).toBe("PdfExtractError");
    expect(err.code).toBe("encrypted");
    expect(err.message).toBe("PDF is locked");
  });
});
