import esbuild from 'esbuild';
import { existsSync, writeFileSync } from 'node:fs';
const userPlugin = {
  name: 'user-plugin',
  setup(build) {
    build.onResolve({ filter: /^virtual:user-plugin$/ }, () => ({ path: 'user-plugin', namespace: 'user-plugin' }));
    build.onLoad({ filter: /.*/, namespace: 'user-plugin' }, () => ({ contents: "export const pluginValue = 'USER_PLUGIN_MARKER'" }));
  }
};
const context = await esbuild.context({
  absWorkingDir: process.cwd(),
  entryPoints: { app: 'src/app.js', admin: 'src/admin.js' },
  bundle: true,
  splitting: true,
  format: 'esm',
  write: true,
  outdir: 'dist',
  chunkNames: 'chunks/[name]-[hash]',
  plugins: [userPlugin]
});
await context.rebuild();
writeFileSync('initial.ready', 'ready');
while (!existsSync('rebuild.trigger')) await new Promise((resolve) => setTimeout(resolve, 25));
await context.rebuild();
await context.dispose();
writeFileSync('updated.ready', 'ready');