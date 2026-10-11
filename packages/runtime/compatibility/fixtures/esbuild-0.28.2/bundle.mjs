import { readFileSync } from 'node:fs';
import esbuild from 'esbuild';
const result = await esbuild.build({ entryPoints: ['oversized.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
const output = result.outputFiles[0];
if (!output) throw new Error('esbuild omitted bundled output');
console.log(JSON.stringify({
  version: esbuild.version,
  inputByteLength: readFileSync('oversized.ts').byteLength,
  outputByteLength: output.contents.byteLength,
  outputExceedsReadBound: output.contents.byteLength > 1_048_576,
  containsMarker: new TextDecoder().decode(output.contents).includes('OVERSIZED_WASI_READ_MARKER'),
  ambientBinaryPath: process.env.ESBUILD_BINARY_PATH ?? null
}));
