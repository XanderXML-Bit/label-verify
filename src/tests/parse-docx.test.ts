import { describe, expect, it } from "vitest";
import { parseApplicationDocx } from "@/lib/application/parse-docx";
import { ApplicationParseError } from "@/lib/application/types";
import mammoth from "mammoth";

// Generating a real .docx in-test is awkward (mammoth reads OOXML
// directly, and the minimal valid OOXML is a multi-file zip). We test
// the dispatcher and error semantics with mocked mammoth output where
// the structural detail isn't the point; a separate integration test
// would cover real .docx parsing against a committed fixture.

describe("parseApplicationDocx", () => {
  it("rejects empty buffer with a helpful error", async () => {
    // mammoth on an empty buffer throws; the parser converts that
    // into a typed ApplicationParseError.
    await expect(parseApplicationDocx(Buffer.from(""))).rejects.toBeInstanceOf(
      ApplicationParseError,
    );
  });

  it("returns parsed fields when mammoth yields a text body", async () => {
    // Spy on mammoth.extractRawText to return a controlled string so
    // the test doesn't need a real .docx fixture.
    const mock = vi
      .spyOn(mammoth, "extractRawText")
      .mockResolvedValueOnce({
        value:
          "Brand Name: Mountain Lager\n" +
          "Class / Type: Lager\n" +
          "Class Category: beer\n" +
          "ABV: 5.0%\n" +
          "Net Contents: 12 fl oz\n" +
          "Producer: Mountain Brewing Co., Denver, CO\n" +
          "Country of Origin: USA\n",
        messages: [],
      });
    const result = await parseApplicationDocx(Buffer.from("dummy"));
    expect(result.source).toBe("docx");
    expect(result.fields.brand_name).toBe("Mountain Lager");
    expect(result.fields.class_type).toBe("Lager");
    expect(result.confidence).toBe("medium");
    mock.mockRestore();
  });

  it("rejects DOCX with no extractable text", async () => {
    const mock = vi
      .spyOn(mammoth, "extractRawText")
      .mockResolvedValueOnce({ value: "   \n  ", messages: [] });
    await expect(
      parseApplicationDocx(Buffer.from("dummy")),
    ).rejects.toThrowError(/no extractable text/i);
    mock.mockRestore();
  });
});

// vitest's `vi` is implicit at the module level inside `describe`
// blocks in modern vitest, but we import it for clarity above.
import { vi } from "vitest";
