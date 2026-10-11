import { rollup, VERSION } from 'rollup';
const bundle = await rollup({ input: 'src/api-entry.js', plugins: [{
  name: 'catalog-api-transform',
  transform(code, id) { return id.endsWith('api-entry.js') ? code.replace('__ROLLUP_API__', JSON.stringify('catalog-api')) : null; }
} ] });
await bundle.write({ file: 'dist/api.js', format: 'esm' });
await bundle.close();
console.log('ROLLUP_API_OK', VERSION);