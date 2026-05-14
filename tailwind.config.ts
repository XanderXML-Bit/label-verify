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
      colors: {
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
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
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
