/**
 * Loads .env for the worker.
 *
 * Next.js does this for the web app automatically, but a plain tsx process does
 * not. Under Docker the environment is supplied by compose and there is no
 * .env file — hence the tolerant catch. Imported first by worker/index.ts so
 * that it runs before any module reads process.env at import time.
 */
try {
  process.loadEnvFile?.();
} catch {
  // No .env file present — environment is supplied some other way.
}

export {};
