# UI / UX Specification

> The TTB team skews 50+ and mixes technical comfort levels. The UI must be
> usable on first sight, without training. (R2.)

## 1. Design Principles

1. **One screen, one job.** No nav, no settings page in v1.
2. **Words over icons.** A button says "Upload Labels", not 📤.
3. **Large hit targets.** Minimum 44 × 44 px for any clickable area.
4. **Generous typography.** Body text 16 px, field labels 14 px, no smaller.
5. **Status is loud and obvious.** Pass/fail uses color *and* a word *and* an
   icon — never color alone (accessibility + clarity).
6. **No spinners-without-text.** "Checking warning statement…" beats a
   silent wheel.
7. **No model jargon visible.** The reviewer never sees "GPT-4o" or
   "tesseract" — they see "Verification complete in 3.2s."

## 2. Screens

### 2.1 Home / Upload

```
┌────────────────────────────────────────────────────────────────┐
│  Label Verification                                            │
│  Compare a label image against an application's declared data │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │              Drop label images here                      │  │
│  │              or click to browse                          │  │
│  │                                                          │  │
│  │              jpg · png · pdf · webp                      │  │
│  │                                                          │  │
│  │              [ Choose files ]                            │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  Or paste a URL:  [____________________________]  [Verify]    │
│                                                                │
│  Application data:                                             │
│  Brand name      [_______________________]                     │
│  Class / type    [_______________________]                     │
│  ABV (%)         [______]                                      │
│  Net contents    [______]  [fl oz ▾]                           │
│  Producer        [_______________________]                     │
│  Country         [_______________________]                     │
│                                                                │
│  [ Bulk import from CSV ]                                      │
│                                                                │
│  [ Verify ▸ ]                                                  │
└────────────────────────────────────────────────────────────────┘
```

- Drag-and-drop is the *primary* affordance. The dashed rectangle is
  unmistakable.
- **Sequential reveal.** The application-data form does not appear until
  after the first image is uploaded. The user is not asked to fill a form
  for an unknown image; the form is the obvious step 2.
- **Batch mode = drag a folder + drop a spreadsheet.** When more than one
  image is detected, the form is replaced by a side-by-side grid: each
  image gets one row, the CSV/XLSX is auto-paired by filename stem, and
  every row is editable inline. "Download template CSV" is one click.
  CSV mismatches (extra rows, missing columns, header typos) surface
  with a row-level "?" marker rather than silently misaligning 300
  verifications.
- The **Verify** button is always enabled, but on click it shows
  per-field validation if anything is missing — so the user sees what is
  needed, instead of staring at a disabled button with a hint that hides.

### 2.2 Results — Single Label

```
┌────────────────────────────────────────────────────────────────┐
│  ◀ Back                                  Verified in 3.2 s  ✓  │
│                                                                │
│  [label image preview]   Image quality:  Good ✓                │
│                          Verdict:        PASS ✓                │
│                                                                │
│  Brand name                                                    │
│  Expected: Stone's Throw Brewing                               │
│  Found:    STONE'S THROW BREWING                       PASS ✓  │
│                                                                │
│  Class / type                                                  │
│  Expected: India Pale Ale                                      │
│  Found:    India Pale Ale                              PASS ✓  │
│                                                                │
│  ABV                                                           │
│  Expected: 6.4 %                                               │
│  Found:    6.4 %                                       PASS ✓  │
│                                                                │
│  Government Warning                                            │
│  Exact text matches federal language?                  PASS ✓  │
│  Prefix all caps?                                      PASS ✓  │
│  Prefix bold (vs body) — ratio 1.6×?                   PASS ✓  │
│  Type size meets §16.22 minimum?                       PASS ✓  │
│                                                                │
│  Net contents                                                  │
│  Expected: 12 fl oz                                            │
│  Found:    12 fl oz                                    PASS ✓  │
│                                                                │
│  Producer / address                                            │
│  Expected: Stone's Throw Brewing Co., 14 Mill St…              │
│  Found:    Stone's Throw Brewing Co., 14 Mill St…      PASS ✓  │
│                                                                │
│  Country of origin                                             │
│  Expected: USA                                                 │
│  Found:    USA                                         PASS ✓  │
│                                                                │
│  [ Download report (PDF) ]   [ Verify another ]                │
└────────────────────────────────────────────────────────────────┘
```

**Two independent verdicts at the top — this is the most consequential
UX decision in the spec.**

- **Image quality** — Good · Low · Re-photograph. CTA on a poor image:
  "Re-upload image." A "Re-photograph" outcome **does not count** as a
  non-compliant label; it is an input problem, not a label problem.
- **Verdict** (compliance) — PASS · FAIL · REVIEW. CTA on FAIL: "Open
  compliance reasons." CTA on REVIEW: "Send to human review queue."

The previous-vendor pattern (every spinner outcome ends in red, the
reviewer cannot tell whether the label is wrong or the photo is bad) is
the single biggest UX failure we are designing against. A regulator who
has lived this will recognize the split immediately — and recognition
is itself a quality signal to the evaluator.

Per-field states: **PASS ✓** (green + check), **FAIL ✗** (red + X),
**REVIEW ⚠** (amber + triangle). Failures float to the top of the field
list, with a bordered emphasis. On `FAIL`, the row expands with the
specific reason — e.g. "Expected `GOVERNMENT WARNING` to be bold (prefix
stroke ≥ 1.4× body stroke); measured 1.05× — not bold." On `REVIEW`, the
row shows a one-sentence action: "Confidence is low — human reviewer
should compare the printed and declared values side by side."

The difference between "the model is unsure" (REVIEW) and "the label is
wrong" (FAIL) is the difference between losing the reviewer's trust and
keeping it.

### 2.3 Results — Batch

```
┌────────────────────────────────────────────────────────────────┐
│  Batch verification     217 / 300 complete    ~3 min remaining │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  72%                                    │
│                                                                │
│  Filter: [ All ▾ ] [ Failed ▾ ] [ Needs review ▾ ]            │
│                                                                │
│  ┌────────────────────────────────────────────────────────────┐│
│  │ #  | File                  | Brand    | Warn | ABV | …    ││
│  │ 1  | label-001.png         | PASS     | PASS | PASS|       ││
│  │ 2  | label-002.png         | PASS     | FAIL | PASS|  ⚠   ││
│  │ 3  | label-003.png         | REVIEW   | PASS | PASS|       ││
│  │ …  | …                                                     ││
│  └────────────────────────────────────────────────────────────┘│
│                                                                │
│  [ Export CSV ]  [ Export PDF report ]                         │
└────────────────────────────────────────────────────────────────┘
```

- Virtualized table for performance at 300 rows.
- Clicking any row drills into the single-label results view.
- The progress bar updates as the SSE stream delivers per-item results.

## 3. Accessibility

- Color-blind safe palette (Pass = green + check, Fail = red + X, Review =
  amber + triangle).
- Full keyboard navigation; the upload zone is operable via Enter, and
  drag-drop has a "Browse" button for keyboard-only and touch users.
- All interactive elements have `aria-label`s.
- Contrast ratio ≥ 4.5:1 throughout.
- **`aria-live` regions** on the streaming-result list so a screen reader
  announces each field as it arrives, not silently.
- **Focus management**: after submit, focus moves to the verdict region so
  the screen reader picks up the overall result before the per-field
  details.
- **`prefers-reduced-motion`** disables the progress-bar shimmer and any
  result-row slide-in.
- **`prefers-contrast: more`** switches to a higher-contrast palette.
- **Font scaling at 200 %** is tested — the result table reflows; nothing
  goes off-canvas.

## 4. Empty / Error States

- **Empty home**: shows the upload zone with a "Try a sample" affordance
  that opens a *three-sample picker*: a clear PASS, a clear FAIL (e.g.
  prefix not bold), and a REVIEW (intentionally low-light photo). App
  data is pre-populated; the user sees end-to-end value in one click.
- **API error** ("we can't reach the vision service"): a clear sentence
  with a Retry button. The error never includes a stack trace; in the
  graceful-degradation path the UI offers "Run OCR-only check" so the
  reviewer at least gets brand, ABV, and Gov Warning text.
- **Bad image**: per-row error with the file name and reason ("Image too
  small — minimum 400 px on long edge.").
- **Network drop mid-batch**: the SSE-reconnect path picks up from the
  last-seen cursor. The user sees a brief "Reconnecting…" banner; no
  results are lost.
- **File too large** (> 10 MB / image): rejected client-side before
  upload with a clear suggestion ("compress this image to ≤ 5 MB").
- **MIME not allowed**: a per-file rejection ("This .heic file isn't
  supported yet — please save as JPEG or PNG."). HEIC support is on the
  P1 list.
- **URL fetch blocked**: if the upstream URL is unreachable (CORS, gov
  firewall, 404), the UI prompts the reviewer to download the image
  locally and drag it in instead.
- **Vision call timeout** (> 5 s): the partial OCR-only verdict surfaces
  with a "Run again with stronger model" CTA. The reviewer is never
  stuck on a spinner.

## 5. Out of Scope for v1

- Dark mode.
- Settings / preferences screen.
- Multi-user history.
- Authentication.

## 6. What Success Looks Like

A reviewer who has never seen the app can:

1. Drag an image onto the page.
2. Fill the form (or paste a URL).
3. Click Verify.
4. Understand the result without asking a question.

If we can't watch a non-technical person do that on a fresh laptop, the UI
is not done.
