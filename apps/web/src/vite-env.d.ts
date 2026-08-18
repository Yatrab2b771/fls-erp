/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Deployed API's origin (no trailing slash) — unset in dev, where Vite's proxy handles /api. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
