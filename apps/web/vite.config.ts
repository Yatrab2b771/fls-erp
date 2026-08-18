import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API runs on :4000 (apps/api) — proxy /api and /uploads in dev so the
// browser never needs CORS or a hardcoded absolute URL; prod build points
// at whatever VITE_API_URL is set to at deploy time (see src/lib/api.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
