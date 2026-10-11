const sass = require('sass');
const { readFileSync } = require('node:fs');
const source = readFileSync('api.scss', 'utf8');
const result = sass.compileString(source, { url: new URL('file://' + process.cwd() + '/api.scss'), style: 'expanded', sourceMap: true, sourceMapIncludeSources: true });
console.log('__SASS_API__' + JSON.stringify({
  info: sass.info,
  css: result.css,
  loadedUrls: result.loadedUrls.map(String),
  sourceMap: result.sourceMap
}));
