import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { mimic } from '@mimic-js/mimic/vite';

// GitHub serves repository archives without CORS headers, so the page reads
// them through its own server. The root vercel.json rewrites the same path in
// production (docs/deploying.md).
const githubArchiveProxy: Record<string, ProxyOptions> = {
  '/github-archive': {
    target: 'https://codeload.github.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/github-archive/, '')
  }
};

export default defineConfig(({ mode }) => {
  // VITE_PREVIEW_ORIGIN names a second hostname of this server that serves the
  // preview documents, or a wildcard such as http://*.localhost:5173 that
  // serves each preview from an origin of its own, so that a client-side
  // router sees the path its server sees; see the package README.
  // .env.development sets the wildcard for `vite dev`, where Chromium and
  // Firefox resolve every *.localhost to this machine.
  const previewOrigin = loadEnv(mode, process.cwd(), 'VITE_').VITE_PREVIEW_ORIGIN || process.env.VITE_PREVIEW_ORIGIN || undefined;
  return {
    plugins: [react(), mimic({ previewOrigin })],
    // The preview origin names this port, so another port is an error rather than a silent mismatch.
    server: { port: 5173, strictPort: true, proxy: githubArchiveProxy },
    preview: { proxy: githubArchiveProxy }
  };
});
