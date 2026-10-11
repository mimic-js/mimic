import esbuild from 'esbuild';
const result = await esbuild.transform('const answer: number = 42', { loader: 'ts', format: 'esm' });
console.log(JSON.stringify({
  version: esbuild.version,
  code: result.code,
  ambientBinaryPath: process.env.ESBUILD_BINARY_PATH ?? null
}));
