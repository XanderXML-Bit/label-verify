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
- Application data form supports either single-row entry (one image) or CSV
  import (batch). CSV columns mirror the field names.
- The "Verify" button stays disabled with a hint until enough fields are
  present.

### 2.2 Results — Single Label

```
┌────────────────────────────────────────────────────────────────┐
│  ◀ Back                                  Verified in 3.2 s  ✓  │
│                                                                │
│  [label image preview]    Overall: PASS ✓                      │
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
│  Expected: 6.4%                                                │
│  Found:    6.4%                                        PASS ✓  │
│                                                                │
│  Government Warning                                            │
│  Prefix bold & all caps?                               PASS ✓  │
│  Exact text matches federal language?                  PASS ✓  │
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

States per field: **PASS ✓** (green), **FAIL ✗** (red), **REVIEW ⚠**
(amber, when confidence < threshold).

On `FAIL`, the row expands with the specific reason — e.g.
"Expected `GOVERNMENT WARNING:` but prefix is not bold."

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
- Full keyboard navigation; the upload zone is operable via Enter.
- All interactive elements have `aria-label`s.
- Contrast ratio ≥ 4.5:1 throughout.

## 4. Empty / Error States

- **Empty home**: shows the upload zone with example labels available via
  "Try a sample" link.
- **API error**: a clear sentence ("We couldn't reach the vision service.
  Retry?") with a Retry button — never a stack trace.
- **Bad image**: per-row error with the file name and reason ("Image too
  small — minimum 400 px on long edge").

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
