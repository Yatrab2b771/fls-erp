// cssnano only runs for a production build (`vite build` sets
// NODE_ENV=production itself) — dev keeps plain, readable CSS so
// DevTools stays useful.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
    ...(process.env.NODE_ENV === "production" ? { cssnano: { preset: "default" } } : {}),
  },
};
