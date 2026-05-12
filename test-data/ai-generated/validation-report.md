# AI-Generated Corpus Validation Report

Validated at: 2026-05-12T03:00:34.714Z

## Summary

- Total primary AI-generated images: 50
- Strict benchmark-ready: 36
- Robustness-only: 14
- Rejects: 0
- Flat label images: 21
- Bottle images: 24
- Can images: 5
- Compliant intended cases: 23
- Non-compliant intended cases: 13
- Review/quality-stress cases: 14

## Ground-Truth Rule

Use `expectedFields`, not `promptDeclaredFields`, for tests. AI generation drifted on producer/address text in multiple images, so the audit corrected the visible field data. Images marked `robustnessOnly` are still useful for OCR/vision stress testing but should not be used as exact full-text benchmark fixtures.

## Coverage

The corpus includes clean flat label artwork, photorealistic bottle/can images, low-light images, glare, partial occlusion, small labels, curved can/bottle surfaces, upside-down orientation, missing warnings, title-case/lowercase warning prefixes, wrong-language warning, missing punctuation, and a subtle net-contents defect.

## Per-Image Audit

| ID | Format | Type | Intended | Case | Usage tier | Notes |
|---|---|---|---|---|---|---|
| ai-label-0001 | bottle | beer | compliant | C0 | strictBenchmarkReady | Compliant warning and primary fields confirmed visually. |
| ai-label-0002 | bottle | wine | compliant | C0 | strictBenchmarkReady | Compliant warning and primary fields confirmed visually. |
| ai-label-0003 | bottle | spirits | compliant | C0 | strictBenchmarkReady | Compliant warning and primary fields confirmed visually. |
| ai-label-0004 | can | ready_to_drink | compliant | C0 | strictBenchmarkReady | Compliant warning and primary fields confirmed visually. Producer line omits plus sign from brand styling. |
| ai-label-0005 | bottle | wine | compliant | C0 | strictBenchmarkReady | Low-light bottle remains legible enough for strict use. |
| ai-label-0006 | bottle | beer | compliant | C0 | robustnessOnly | Glare condition confirmed; exact full text should not be used as strict benchmark. |
| ai-label-0007 | bottle | spirits | compliant | C0 | strictBenchmarkReady | Compact side label; warning confirmed. Country of origin was prompt-intended but not visually confirmed. |
| ai-label-0008 | bottle | beer | compliant | C0 | robustnessOnly | Angled bottle useful for robustness; warning is too small/tilted for exact certification. |
| ai-label-0009 | bottle | wine | non_compliant | X1_MISSING_WARNING | strictBenchmarkReady | Missing government warning defect clearly confirmed. |
| ai-label-0010 | bottle | spirits | non_compliant | T1_PREFIX_TITLE_CASE | strictBenchmarkReady | Title-case warning prefix defect confirmed. |
| ai-label-0011 | bottle | beer | non_compliant | T2_PREFIX_LOWERCASE | strictBenchmarkReady | Lowercase warning prefix defect confirmed. |
| ai-label-0012 | bottle | fortified_wine | non_compliant | X3_WRONG_LANGUAGE | strictBenchmarkReady | Spanish-only warning defect confirmed; canonical English warning absent. |
| ai-label-0013 | bottle | wine | review | Q2_GLARE_WARNING | robustnessOnly | Glare crosses warning body; keep as robustness case. |
| ai-label-0014 | can | beer | review | Q3_PARTIAL_OCCLUSION | robustnessOnly | Partial occlusion condition confirmed; producer/address area not clean enough for strict use. |
| ai-label-0015 | bottle | spirits | review | Q4_BLUR_LOW_LIGHT | robustnessOnly | Blur/tilt/low-light condition confirmed; not strict exact-text material. |
| ai-label-0016 | bottle | spirits | compliant | C0 | strictBenchmarkReady | Mini bottle primary fields and compliant warning confirmed. Country of origin was prompt-intended but not visually confirmed. |
| ai-label-0017 | flat_label | beer | compliant | C0 | strictBenchmarkReady | Clean flat beer label; exact warning confirmed. |
| ai-label-0018 | flat_label | wine | compliant | C0 | strictBenchmarkReady | Clean flat wine label; exact warning confirmed. |
| ai-label-0019 | flat_label | spirits | compliant | C0 | strictBenchmarkReady | Clean flat spirits label; exact warning confirmed. |
| ai-label-0020 | flat_label | ready_to_drink | compliant | C0 | strictBenchmarkReady | Clean flat RTD label; exact warning confirmed. |
| ai-label-0021 | flat_label | wine | compliant | C0 | strictBenchmarkReady | Low-light flat label remains strict-usable. |
| ai-label-0022 | flat_label | beer | non_compliant | X1_MISSING_WARNING | strictBenchmarkReady | Missing government warning defect clearly confirmed. |
| ai-label-0023 | flat_label | spirits | non_compliant | T1_PREFIX_TITLE_CASE | strictBenchmarkReady | Title-case warning prefix defect confirmed. |
| ai-label-0024 | flat_label | beer | non_compliant | T2_PREFIX_LOWERCASE | strictBenchmarkReady | Lowercase warning prefix defect confirmed. |
| ai-label-0025 | bottle | beer | compliant | C0 | strictBenchmarkReady | Bottle label; compliant warning confirmed. |
| ai-label-0026 | flat_label | wine | review | Q5_STAIN | strictBenchmarkReady | Coffee stain condition confirmed; warning remains strict-usable. |
| ai-label-0027 | bottle | wine | compliant | C0 | strictBenchmarkReady | Wine bottle; compliant warning confirmed. |
| ai-label-0028 | can | ready_to_drink | compliant | C0 | strictBenchmarkReady | Can label; compliant warning confirmed. |
| ai-label-0029 | flat_label | spirits | compliant | C0 | strictBenchmarkReady | Flat spirits label; compliant warning confirmed. |
| ai-label-0030 | bottle | spirits | review | Q4_LOW_LIGHT | robustnessOnly | Low-light bottle useful for robustness; not strict exact-text material. |
| ai-label-0031 | flat_label | wine | review | Q6_ROTATED_180 | robustnessOnly | Upside-down orientation case; keep robustness-only. |
| ai-label-0032 | flat_label | beer | non_compliant | X4_MISSING_COMMA | strictBenchmarkReady | Subtle missing comma after Surgeon General confirmed. |
| ai-label-0033 | bottle | wine | review | Q2_GLARE_WARNING | robustnessOnly | Diagonal glare crosses warning; keep robustness-only. |
| ai-label-0034 | flat_label | beer | compliant | C0 | strictBenchmarkReady | Flat regulatory back-label; exact warning confirmed. |
| ai-label-0035 | bottle | wine | compliant | C0 | strictBenchmarkReady | Wine bottle back label; exact warning confirmed. |
| ai-label-0036 | flat_label | spirits | non_compliant | T1_PREFIX_TITLE_CASE | strictBenchmarkReady | Title-case warning prefix defect confirmed. |
| ai-label-0037 | can | cider | compliant | C0 | strictBenchmarkReady | Curved cider can; exact warning confirmed. |
| ai-label-0038 | flat_label | wine | review | Q5_STAIN_WRINKLE | strictBenchmarkReady | Wrinkle/stain condition confirmed; warning remains strict-usable. |
| ai-label-0039 | bottle | spirits | review | Q4_LOW_LIGHT_BLUR | robustnessOnly | Warm low-light/blur bottle; not strict exact-text material. |
| ai-label-0040 | flat_label | fortified_wine | non_compliant | X5_MISSING_PREFIX_COLON | strictBenchmarkReady | Missing colon after GOVERNMENT WARNING confirmed. |
| ai-label-0041 | bottle | wine | compliant | C0 | strictBenchmarkReady | Angled/frosted bottle; exact warning and fields confirmed. |
| ai-label-0042 | flat_label | beer | non_compliant | X1_MISSING_WARNING | strictBenchmarkReady | Missing government warning defect clearly confirmed. |
| ai-label-0043 | can | ready_to_drink | non_compliant | T2_PREFIX_LOWERCASE | strictBenchmarkReady | Lowercase warning prefix defect confirmed. |
| ai-label-0044 | flat_label | spirits | compliant | C0 | strictBenchmarkReady | Importer back label; exact warning and fields confirmed. |
| ai-label-0045 | bottle | wine | review | Q3_PARTIAL_OCCLUSION | robustnessOnly | Thumb occlusion covers part of importer/producer line; keep robustness-only. |
| ai-label-0046 | flat_label | mead | review | S2_WARNING_TOO_SMALL | robustnessOnly | Warning intentionally tiny; primary fields legible but exact warning cannot be certified. |
| ai-label-0047 | bottle | wine | review | Q2_FLASH_GLARE | robustnessOnly | Flash glare obscures class/type; keep robustness-only. |
| ai-label-0048 | flat_label | beer | non_compliant | N1_NET_CONTENTS_LETTER_O | strictBenchmarkReady | Dark label remains legible. Net contents appears as letter O instead of zero; recorded as subtle non-warning defect. |
| ai-label-0049 | bottle | spirits | review | S2_MINI_TINY_TEXT | robustnessOnly | Mini bottle tiny curved warning; keep robustness-only. |
| ai-label-0050 | flat_label | beer | review | Q6_ROTATED_180 | robustnessOnly | Upside-down orientation case; keep robustness-only. |
