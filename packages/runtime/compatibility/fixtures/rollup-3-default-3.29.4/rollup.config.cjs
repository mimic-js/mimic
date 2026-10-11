module.exports = { input: { entry: 'entry.js', admin: 'admin.js' }, output: [
  { dir: 'cli-dist/esm', format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
  { dir: 'cli-dist/cjs', format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' }
] };