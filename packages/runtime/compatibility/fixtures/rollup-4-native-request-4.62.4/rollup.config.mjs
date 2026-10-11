export default {
  input: 'src/cli-entry.js',
  output: { file: 'dist/cli.js', format: 'esm' },
  plugins: [{ name: 'catalog-cli-transform', transform(code, id) {
    return id.endsWith('cli-entry.js') ? code.replace('__ROLLUP_CLI__', JSON.stringify('catalog-cli')) : null;
  } }]
};