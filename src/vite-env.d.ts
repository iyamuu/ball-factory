/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Apps Script web app URL for round telemetry (docs/TELEMETRY.md). Unset: nothing is sent. */
  readonly VITE_TELEMETRY_URL?: string;
  /** Build identifier stored with telemetry records (the deploy workflow passes the commit SHA). */
  readonly VITE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
