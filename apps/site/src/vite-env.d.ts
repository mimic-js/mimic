/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** A second hostname of this deployment that serves the preview documents; see the package README. */
  readonly VITE_PREVIEW_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
