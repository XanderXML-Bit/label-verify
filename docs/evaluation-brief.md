# TTB Label Verification — Project Brief

> **Status:** Bible document. Every design decision in this repo traces back to
> a requirement on this page. If a feature does not map to something here, it
> probably should not be built.
>
> **Provenance:** This brief records this repository's own goals and targets.
> It is not an agency requirement, and a target here is not a measured result.
> Measured numbers live in the README and the benchmark reports. The only
> external source cited is the public federal regulation in §6.

## 1. Project Context

- **Domain:** Certificate of Label Approval (COLA) verification for TTB-regulated alcohol labels
- **Format:** Public GitHub repository + a deployed, reachable URL
- **Scope:** Standalone prototype demonstrating AI-assisted label verification

## 2. Problem Statement

Checking a label by hand means comparing the submitted label artwork against
the application form, field by field, to confirm the printed label matches
what the applicant declared.

This is slow, mechanical, and error-prone — exactly the kind of work AI
should accelerate. This project sets itself a target of about **5 seconds per
label**, so that a reviewer can keep working without waiting on the tool.

## 3. What We Are Building

A **standalone prototype** that, given a label image (or batch of label
images) plus the declared application data, returns a structured pass/fail
verdict for each regulated field, with confidence scores and an explanation
of any mismatch.

The prototype does **not** integrate with TTB's COLA system. It is a
self-contained demo of the verification engine and a usable UI on top of it.

## 4. Hard Requirements

These are the project's own targets. The Source column says where each one
comes from.

| # | Requirement | Source |
|---|-------------|--------|
| R1 | End-to-end response in **~5 seconds** per label | Project target |
| R2 | UI usable by **non-technical reviewers** | Project target |
| R3 | **Batch upload** of 200–300 labels | Project target (batch workflow) |
| R4 | Tolerant of **imperfect images** (angles, glare, low light, partial occlusion) | Project target (real-world photos) |
| R5 | **Exact-match** Government Warning: literal text, all caps `GOVERNMENT WARNING:`, bold | Federal regulation (27 CFR § 16.21, §6); strict |
| R6 | **Fuzzy** brand-name matching (`STONE'S THROW` ≡ `Stone's Throw`) | Project target |
| R7 | **Standalone** — no COLA system integration | Project scope |
| R8 | **Deployed URL** + **public repo** | Project scope |

## 5. Regulated Fields to Verify

Each of these must be extracted from the label image and compared against the
declared application value:

1. **Brand name** — fuzzy match (case/punctuation/whitespace insensitive)
2. **Class / type designation** — controlled vocabulary (beer, wine, distilled spirit, fortified wine, etc.)
3. **Alcohol by volume (ABV)** — numeric, within tolerance bands defined by class
4. **Net contents** — volume + unit; unit conversions allowed
5. **Government Warning statement** — **strict** exact match, all caps, bold
6. **Name and address** of bottler / importer / producer
7. **Country of origin** (for imports)

## 6. Government Warning — The Strict Field

Federal law (27 CFR § 16.21) mandates this exact text:

> **GOVERNMENT WARNING:** (1) According to the Surgeon General, women should
> not drink alcoholic beverages during pregnancy because of the risk of birth
> defects. (2) Consumption of alcoholic beverages impairs your ability to
> drive a car or operate machinery, and may cause health problems.

Validation rules:

- `GOVERNMENT WARNING:` prefix must be present, **all caps**, **bold**.
- Body text must match the regulated string. Hyphenation, line breaks, and
  font face may vary; the *characters* must not.
- A single missing word, swapped word, or non-bold prefix is a **fail**.
- Detection must survive low-resolution renders and angled photos.

## 7. Evaluation Criteria

The project holds itself to these criteria:

1. **Correctness** — does it actually verify labels accurately?
2. **Code quality** — clean, readable, idiomatic, tested.
3. **User experience** — can a non-technical reviewer use it on day one?
4. **Tech choices** — sensible stack, clear justification.
5. **Attention to stated requirements** — every R1–R8 visibly addressed.
6. **Creative problem-solving** — interesting decisions, not cargo-culted.

The guiding principle: **a working core beats an ambitious incomplete
attempt.** Scope discipline is itself part of the design.

## 8. Latitude

- Any language, framework, library, model provider.
- Any deployment target.
- Free choice of OCR / vision approach.
- Test data is our responsibility to generate.

## 9. Out of Scope (Explicit Non-Goals)

- COLA system integration.
- Authentication, user accounts, audit logging (it's a prototype).
- Multi-tenant support.
- Persistent storage of submitted labels beyond the active session.
- Mobile apps.

## 10. Risks We Acknowledge Up-Front

- **Restricted networks** — some managed networks block third-party
  domains. Our deployment must work from a standard browser; our verification
  pipeline should degrade gracefully if a hosted model is unreachable. See
  `docs/archive/APPROACH.md` for the local-model fallback plan (the
  pre-implementation planning doc; never shipped as code).
- **5-second budget is tight** for vision-model calls — multiple round trips
  to a hosted LLM will not fit. See `docs/ARCHITECTURE.md` §4 (Latency budget).
- **Ground truth is hard** — we need test labels where we *know* every field
  precisely. See `TEST-STRATEGY.md`.
