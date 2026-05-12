import { describe, it, expect } from "vitest";
import { compareProducer } from "@/lib/matching";
import type { ProducerAddress } from "@/lib/vision/types";

// ─── Regression tests for the 2026-05-12 security audit (finding #2/#3)
//
// The implicit-USA inference for the country comparator is gated on
// two things now:
//   1. extracted.state is a STRICT-format 2-letter US state code (no
//      punctuation, no junk) — so a hallucinated "M.E." or "me!!"
//      can't pass.
//   2. At least one OTHER component of the producer (name / street /
//      city / postal_code) ALSO matches the declared address — so a
//      hallucinated state alone can't downgrade an obvious mismatch.

describe("producer comparator — spoof resistance", () => {
  const declaredUsa: ProducerAddress = {
    name: "Mill Creek Beverage Co.",
    street: "100 Brewery Way",
    city: "Asheville",
    state: "NC",
    postal_code: "28801",
    country: "USA",
  };

  it("rejects implicit-USA when state has punctuation noise", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "N.C.", // periods in state code
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });

  it("rejects implicit-USA when state is junk that normalises to a US code", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "n!c!", // strips to "NC" but isn't a real state field
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });

  it("rejects implicit-USA when NO other component corroborates", () => {
    // A clear non-compliance: producer is in Mexico (different name,
    // street, city, postal) but model hallucinated state = "ME". The
    // implicit-USA rule must NOT fire because no other piece of the
    // producer address matches.
    const extracted: ProducerAddress = {
      name: "Mexico Bottling Plant",
      street: "Av. Reforma 123",
      city: "Tequila, Jalisco",
      state: "ME", // hallucinated 2-letter (could also be Maine!)
      postal_code: "12345",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
    expect(r.status).toBe("fail"); // multiple components fail → fail
  });

  it("accepts implicit-USA when state is valid AND city corroborates", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "NC",
      country: null,
      // name/street fail, but city + postal corroborate
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("pass");
  });

  it("accepts implicit-USA when state is valid AND postal_code corroborates", () => {
    const extracted: ProducerAddress = {
      ...declaredUsa,
      state: "NC",
      city: "WRONG_CITY",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    // postal_code still corroborates
    expect(r.components?.country).toBe("pass");
  });

  it("accepts implicit-USA when state is valid AND name corroborates", () => {
    const extracted: ProducerAddress = {
      name: "Mill Creek Beverage Co.",
      street: null,
      city: null,
      state: "NC",
      postal_code: null,
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    // name corroborates the state's implicit-USA claim
    expect(r.components?.country).toBe("pass");
  });

  it("rejects implicit-USA when only state matches and everything else is bogus", () => {
    const extracted: ProducerAddress = {
      name: "XYZ123",
      street: "999 Wrong St",
      city: "Wrongville",
      state: "NC", // valid US code, but nothing else lines up
      postal_code: "99999",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });

  it("EXPLICIT country wins even with corroborating components", () => {
    // If the label clearly says "Mexico", we must NOT silently override
    // even when state happens to be a US code and other components
    // match. The explicit country field is authoritative.
    const extracted: ProducerAddress = {
      ...declaredUsa,
      country: "Mexico",
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });

  // Per REMAINING-IMPROVEMENTS.md T2: an edge case where the model
  // hallucinates a US-style state ("ME" / Maine) but every other
  // textual field on the producer points to a Mexican producer.
  // Country MUST fail — the corroborating-component rule is what
  // prevents a single hallucinated state code from rubber-stamping
  // an obvious mismatch.
  it("rejects implicit-USA when state='ME' but name+city+street name a Mexican producer", () => {
    const extracted: ProducerAddress = {
      name: "Mexican Tequila Co",
      street: "Calle Juarez 200",
      city: "Guadalajara",
      state: "ME", // hallucinated US-state code (Maine) but no actual US context
      postal_code: "44100",
      country: null,
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
    expect(r.status).toBe("fail");
  });

  it("rejects EXPLICIT 'MEXICO' even when every other component matches declared US producer", () => {
    // All five corroborating components match, but the label printed
    // country "MEXICO". The explicit-country branch must override
    // every other signal — the rule is "what the label SAYS is
    // authoritative, what we INFER is hedge-only".
    const extracted: ProducerAddress = {
      ...declaredUsa,
      country: "MEXICO",
    };
    const r = compareProducer(declaredUsa, extracted, 0.9);
    expect(r.components?.country).toBe("fail");
  });
});
