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
        // are always present (see docs/UI-SPEC.md §1.5).
        pass: "#15803d",
        fail: "#b91c1c",
        review: "#a16207",
        // Verdict and Image-Quality use distinct hue families so the
        // reviewer learns to read the two columns separately.
        verdict: {
          pass: "#15803d",
          fail: "#b91c1c",
          review: "#a16207",
        },
        quality: {
          good: "#1e40af",
          low: "#a16207",
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
