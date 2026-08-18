import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? "8h",
  PORT: Number(process.env.PORT ?? 4000),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  UPLOADS_DIR: process.env.UPLOADS_DIR ?? "uploads",
  // Comma-separated allowed origins for the deployed web app (e.g. the
  // Vercel URL). Unset = reflect any origin — fine for local dev, and not
  // a real risk even in prod since auth is a Bearer token, not a cookie
  // (no CSRF surface), but set this once the frontend has a real URL.
  FRONTEND_URL: process.env.FRONTEND_URL,
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL ?? "admin@fls.local",
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!",
  SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD ?? "Demo1234!",
};
