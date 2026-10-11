import { readFileSync } from 'node:fs';
import esbuild from 'esbuild';
const transform = await esbuild.transform('const answer: number = 42', { loader: 'ts', format: 'esm' });
const service = await esbuild.context({
  entryPoints: ['service-entry.ts'],
  bundle: true,
  format: 'esm',
  write: true,
  outfile: 'service-out.js',
  logLevel: 'silent'
});
await service.rebuild();
await service.dispose();
console.log(JSON.stringify({
  version: esbuild.version,
  nodeVersion: process.version,
  transformCode: transform.code,
  serviceOutput: readFileSync('service-out.js', 'utf8'),
  ambientBinaryPath: process.env.ESBUILD_BINARY_PATH ?? null
}));
