/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
        },
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15,23,42,.04), 0 1px 1px rgba(15,23,42,.03)",
        card: "0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04)",
        lift: "0 12px 28px -8px rgba(15,23,42,.16), 0 4px 10px -4px rgba(15,23,42,.08)",
        glow: "0 8px 24px -6px var(--tw-shadow-color)",
      },
      animation: {
        "fade-in": "fadeIn .45s cubic-bezier(.16,1,.3,1)",
        "scale-in": "scaleIn .3s cubic-bezier(.16,1,.3,1)",
        "slide-up": "slideUp .35s cubic-bezier(.16,1,.3,1)",
        shimmer: "shimmer 1.8s linear infinite",
      },
      keyframes: {
        fadeIn: { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        scaleIn: { from: { opacity: 0, transform: "scale(.96)" }, to: { opacity: 1, transform: "scale(1)" } },
        slideUp: { from: { opacity: 0, transform: "translateY(14px)" }, to: { opacity: 1, transform: "translateY(0)" } },
        shimmer: { from: { backgroundPosition: "-200% 0" }, to: { backgroundPosition: "200% 0" } },
      },
    },
  },
  plugins: [],
};
