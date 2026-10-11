const { readdirSync, statSync } = require('node:fs');
const { rollup, VERSION } = require('rollup');
(async () => {
const bundle = await rollup({ input: { entry: 'entry.js', admin: 'admin.js' } });
try {
  await bundle.write({ dir: 'api-dist', format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' });
} finally { await bundle.close(); }
const apiOutput = walk('api-dist');
if (!apiOutput.some((path) => path.startsWith('chunks/'))) throw new Error('Rollup API did not create a shared or dynamic chunk');
console.log('ROLLUP_3_DEFAULT_API', VERSION, apiOutput.join(','));
function walk(directory, prefix = '') { return readdirSync(directory).flatMap((name) => { const path = directory + '/' + name; const relative = prefix + name; return statSync(path).isDirectory() ? walk(path, relative + '/') : [relative]; }); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });