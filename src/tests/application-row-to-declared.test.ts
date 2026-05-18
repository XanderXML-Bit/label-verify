// Wave-35e — coverage on src/lib/application/row-to-declared.ts.
//
// This is the alias-normalisation surface for every CSV / JSON
// application input. Reviewers export from different TTB tools
// with subtly different column names; the function maps them into
// the canonical DeclaredFields shape. Wave-35e code-audit flagged
// the lack of a dedicated test file — every alias permitted by
// the source MUST round-trip to the same canonical field.

import { describe, expect, it } from "vitest";
import { rowToDeclared } from "@/lib/application/row-to-declared";

describe("rowToDeclared — brand_name aliases", () => {
  it("accepts brand_name", () => {
    expect(rowToDeclared({ brand_name: "Stones Throw IPA" }).brand_name).toBe(
      "Stones Throw IPA",
    );
  });

  it("accepts brand", () => {
    expect(rowToDeclared({ brand: "Stones Throw IPA" }).brand_name).toBe(
      "Stones Throw IPA",
    );
  });

  it("accepts 'brand name' (space form)", () => {
    expect(rowToDeclared({ "brand name": "Stones Throw IPA" }).brand_name).toBe(
      "Stones Throw IPA",
    );
  });

  it("trims whitespace", () => {
    expect(rowToDeclared({ brand: "  Pilsner Reserve  " }).brand_name).toBe(
      "Pilsner Reserve",
    );
  });

  it("returns undefined when no alias is present", () => {
    expect(rowToDeclared({}).brand_name).toBeUndefined();
  });

  it("returns undefined when the value is empty / whitespace-only", () => {
    expect(rowToDeclared({ brand: "   " }).brand_name).toBeUndefined();
    expect(rowToDeclared({ brand: "" }).brand_name).toBeUndefined();
  });
});

describe("rowToDeclared — class_type aliases", () => {
  it.each([
    ["class_type", "India Pale Ale"],
    ["class", "Lager"],
    ["type", "Cabernet Sauvignon"],
    ["class/type", "Stout"],
    ["style", "Pilsner"],
  ])("accepts %s → %s", (alias, value) => {
    expect(rowToDeclared({ [alias]: value }).class_type).toBe(value);
  });
});

describe("rowToDeclared — class_category normalisation", () => {
  it.each([
    ["beer", "beer"],
    ["BEER", "beer"],
    ["malt", "beer"],
    ["wine", "wine"],
    ["WINE", "wine"],
    ["distilled_spirits", "distilled_spirits"],
    ["distilled spirits", "distilled_spirits"],
    ["spirits", "distilled_spirits"],
    ["fortified_wine", "fortified_wine"],
    ["fortified wine", "fortified_wine"],
  ])("normalises class_category %s → %s", (raw, expected) => {
    expect(rowToDeclared({ class_category: raw }).class_category).toBe(
      expected,
    );
  });

  it("returns undefined on unknown category", () => {
    expect(rowToDeclared({ class_category: "mead" }).class_category).toBeUndefined();
    expect(rowToDeclared({ class_category: "" }).class_category).toBeUndefined();
  });

  it("accepts category / beverage_type aliases", () => {
    expect(rowToDeclared({ category: "wine" }).class_category).toBe("wine");
    expect(rowToDeclared({ beverage_type: "beer" }).class_category).toBe(
      "beer",
    );
  });
});

describe("rowToDeclared — ABV parsing", () => {
  it("accepts plain numeric string", () => {
    expect(rowToDeclared({ abv_percent: "6.4" }).abv_percent).toBe(6.4);
  });

  it("strips the % suffix", () => {
    expect(rowToDeclared({ abv_percent: "6.4%" }).abv_percent).toBe(6.4);
  });

  it("accepts comma decimal (European locale)", () => {
    expect(rowToDeclared({ abv_percent: "6,4" }).abv_percent).toBe(6.4);
  });

  it("accepts abv / abv% / alcohol / alcohol_by_volume aliases", () => {
    expect(rowToDeclared({ abv: "5.0" }).abv_percent).toBe(5.0);
    expect(rowToDeclared({ "abv%": "5.0" }).abv_percent).toBe(5.0);
    expect(rowToDeclared({ alcohol: "5.0" }).abv_percent).toBe(5.0);
    expect(rowToDeclared({ alcohol_by_volume: "5.0" }).abv_percent).toBe(5.0);
  });

  it("returns undefined on non-numeric input", () => {
    expect(rowToDeclared({ abv: "high" }).abv_percent).toBeUndefined();
    expect(rowToDeclared({ abv: "" }).abv_percent).toBeUndefined();
  });

  it("returns undefined when no alias is present", () => {
    expect(rowToDeclared({}).abv_percent).toBeUndefined();
  });
});

describe("rowToDeclared — net_contents parsing (unit-aware)", () => {
  it("parses 12 fl_oz", () => {
    expect(rowToDeclared({ net_contents: "12 fl_oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
  });

  it("parses '12 fl oz' (space variant) and normalises the unit", () => {
    expect(rowToDeclared({ net_contents: "12 fl oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
  });

  it("parses 355 ml", () => {
    expect(rowToDeclared({ net_contents: "355 ml" }).net_contents).toEqual({
      value: 355,
      unit: "ml",
    });
  });

  it("parses 750ml (no space)", () => {
    expect(rowToDeclared({ net_contents: "750ml" }).net_contents).toEqual({
      value: 750,
      unit: "ml",
    });
  });

  it("parses 1.5 L (decimal + uppercase unit)", () => {
    expect(rowToDeclared({ net_contents: "1.5 L" }).net_contents).toEqual({
      value: 1.5,
      unit: "l",
    });
  });

  it("parses 75cl", () => {
    expect(rowToDeclared({ net_contents: "75cl" }).net_contents).toEqual({
      value: 75,
      unit: "cl",
    });
  });

  it("accepts the netContents / 'net contents' / volume / size aliases", () => {
    expect(rowToDeclared({ netContents: "12 fl_oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
    expect(rowToDeclared({ "net contents": "12 fl_oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
    expect(rowToDeclared({ volume: "12 fl_oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
    expect(rowToDeclared({ size: "12 fl_oz" }).net_contents).toEqual({
      value: 12,
      unit: "fl_oz",
    });
  });

  it("returns undefined on unparseable net_contents", () => {
    expect(rowToDeclared({ net_contents: "twelve fl oz" }).net_contents).toBeUndefined();
    expect(rowToDeclared({ net_contents: "12 pints" }).net_contents).toBeUndefined();
  });
});

describe("rowToDeclared — producer (structured vs freeform)", () => {
  it("returns a structured object when producer_name is present", () => {
    const out = rowToDeclared({
      producer_name: "Acme Brewing",
      producer_street: "1 Main St",
      producer_city: "Asheville",
      producer_state: "NC",
      producer_postal: "28801",
      producer_country: "USA",
    });
    expect(out.producer).toEqual({
      name: "Acme Brewing",
      street: "1 Main St",
      city: "Asheville",
      state: "NC",
      postal_code: "28801",
      country: "USA",
    });
  });

  it("treats `producer` as freeform string when producer_name is absent", () => {
    const out = rowToDeclared({
      producer: "Acme Brewing Co., 1 Main St, Asheville, NC 28801, USA",
    });
    expect(out.producer).toBe(
      "Acme Brewing Co., 1 Main St, Asheville, NC 28801, USA",
    );
  });

  it("accepts producer_address / producer_line aliases for freeform string", () => {
    expect(rowToDeclared({ producer_address: "Acme, NC" }).producer).toBe(
      "Acme, NC",
    );
    expect(rowToDeclared({ producer_line: "Acme, NC" }).producer).toBe(
      "Acme, NC",
    );
  });

  it("structured producer leaves missing component fields as null (not undefined)", () => {
    const out = rowToDeclared({ producer_name: "Acme Brewing" });
    expect(out.producer).toEqual({
      name: "Acme Brewing",
      street: null,
      city: null,
      state: null,
      postal_code: null,
      country: null,
    });
  });

  it("structured fields accept their short aliases (street, city, state, zip)", () => {
    const out = rowToDeclared({
      producer_name: "Acme",
      street: "1 Main",
      city: "Asheville",
      state: "NC",
      zip: "28801",
    });
    expect(out.producer).toMatchObject({
      street: "1 Main",
      city: "Asheville",
      state: "NC",
      postal_code: "28801",
    });
  });

  it("returns undefined producer when no producer alias present", () => {
    expect(rowToDeclared({}).producer).toBeUndefined();
  });
});

describe("rowToDeclared — country_of_origin handling", () => {
  it("accepts country alias", () => {
    expect(rowToDeclared({ country: "USA" }).country_of_origin).toBe("USA");
  });

  it("accepts country_of_origin alias", () => {
    expect(rowToDeclared({ country_of_origin: "Mexico" }).country_of_origin).toBe(
      "Mexico",
    );
  });

  it("accepts origin alias", () => {
    expect(rowToDeclared({ origin: "Italy" }).country_of_origin).toBe("Italy");
  });

  it("returns NULL (not undefined) when no country is supplied — US-domestic apps legitimately omit it", () => {
    // The downstream schema accepts null OR a string. Returning `null`
    // is the documented signal "no country was declared" and the
    // comparator's implicit-USA-from-state path triggers off it.
    const out = rowToDeclared({});
    expect(out.country_of_origin).toBeNull();
  });
});

describe("rowToDeclared — unknown columns are ignored", () => {
  it("ignores columns that aren't in any alias list", () => {
    const out = rowToDeclared({
      brand: "Test",
      // bogus columns the reviewer might have in their spreadsheet
      tta_form_id: "12345",
      submitted_by: "reviewer@example.com",
      notes: "Some QA notes",
    });
    expect(out.brand_name).toBe("Test");
    expect(Object.keys(out)).not.toContain("tta_form_id");
    expect(Object.keys(out)).not.toContain("submitted_by");
    expect(Object.keys(out)).not.toContain("notes");
  });
});

describe("rowToDeclared — composite happy path", () => {
  it("round-trips a fully-populated row to the canonical DeclaredFields shape", () => {
    const out = rowToDeclared({
      brand: "Stones Throw IPA",
      class_type: "India Pale Ale",
      class_category: "beer",
      abv: "6.4%",
      net_contents: "12 fl_oz",
      producer: "Stones Throw Brewing Co., San Diego, CA, USA",
      country: "USA",
    });
    expect(out).toEqual({
      brand_name: "Stones Throw IPA",
      class_type: "India Pale Ale",
      class_category: "beer",
      abv_percent: 6.4,
      net_contents: { value: 12, unit: "fl_oz" },
      producer: "Stones Throw Brewing Co., San Diego, CA, USA",
      country_of_origin: "USA",
    });
  });
});
