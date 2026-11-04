import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // Dark mode is driven by a `data-theme="dark"` attribute on <html>,
  // written by the pre-paint inline script in layout.tsx and toggled at
  // runtime by ThemeToggle. The `["class", '[data-theme="dark"]']` form
  // tells Tailwind 3.4 to emit dark-mode utilities behind that selector
  // (instead of `.dark`), which keeps the theme contract in one place.
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      // ── Brand tokens (Zendren Studio family) ─────────────────────────
      // This file is the single source of truth for colour and type.
      // globals.css reads these values through Tailwind's theme() helper,
      // so no hex value is duplicated anywhere else in the app.
      //
      // `slate` and `blue` are overridden (not added) so every existing
      // utility class (`bg-slate-900`, `text-blue-700`, …) picks up the
      // Studio palette without touching component markup:
      //   - slate → Studio navy, with deep navy-black at 950/900.
      //     Browser accessibility checks cover the idle and privacy pages.
      //   - blue  → Studio blue. 400 = primary #6ba8ff; 600 = button end
      //     #2965c4 (white text 5.6:1). 500 is a darker interpolation than
      //     the #4e8ffa button start so white text on it still clears
      //     AA-large; #4e8ffa itself is kept as `brand.blue-start`.
      //   - brand.teal #7bd2c2 and brand.highlight #e3a260 are the Studio
      //     secondary and warm highlight.
      colors: {
        slate: {
          50: "#f6f8fc",
          100: "#edf1f8",
          200: "#dce3ef",
          300: "#c3cde0",
          400: "#97a4bf",
          500: "#65728e",
          600: "#455270",
          700: "#2f3b56",
          800: "#1c2640",
          900: "#0f172b",
          950: "#070c1a",
        },
        blue: {
          50: "#eef5ff",
          100: "#dceaff",
          200: "#bdd8ff",
          300: "#93c0ff",
          400: "#6ba8ff",
          500: "#3d7fe6",
          600: "#2965c4",
          700: "#2152a3",
          800: "#1d4384",
          900: "#1a3866",
          950: "#0f2243",
        },
        brand: {
          primary: "#6ba8ff",
          "blue-start": "#4e8ffa",
          "blue-end": "#2965c4",
          teal: "#7bd2c2",
          highlight: "#e3a260",
          navy: "#070c1a",
        },
        // High-contrast palette tuned for the 55+ reviewer audience.
        // Pass / Fail / Review never communicate by color alone — icon + word
        // are always present.
        //
        // Verdict-review uses yellow-800 (#854d0e) not yellow-700 (#a16207):
        // the chip rendered at `text-xs` (12px) on `bg-yellow-100` (#fef3c7)
        // needed 4.5:1 for WCAG AA small-text. #a16207 gave 4.33:1 (fail
        // by 0.17) per the audit; #854d0e gives ~6.04:1 (passes both AA
        // and AAA-large). Same darker shade applied to quality-low for
        // visual consistency, even though quality-low's lighter amber-50
        // background was technically at threshold.
        pass: "#15803d",
        fail: "#b91c1c",
        review: "#854d0e",
        // Verdict and Image-Quality use distinct hue families so the
        // reviewer learns to read the two columns separately.
        verdict: {
          pass: "#15803d",
          fail: "#b91c1c",
          review: "#854d0e",
        },
        quality: {
          good: "#1e40af",
          low: "#854d0e",
          bad: "#7c2d12",
        },
      },
      // Studio typography: Sora (display), Manrope (body), IBM Plex Mono.
      // Self-hosted by next/font (layout.tsx) with font-display: swap;
      // the CSS variables are set on <html>.
      fontFamily: {
        sans: ["var(--font-manrope)", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        display: ["var(--font-sora)", "var(--font-manrope)", "system-ui", "sans-serif"],
        mono: ["var(--font-plex-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // Floor at 16px body, 14px field labels. Spec calls this out.
        base: ["1rem", { lineHeight: "1.6" }],
        label: ["0.875rem", { lineHeight: "1.4" }],
      },
    },
  },
  plugins: [],
};

export default config;
