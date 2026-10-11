import { readFileSync, readdirSync } from 'node:fs';
const logical = JSON.parse(readFileSync('node_modules/rolldown/package.json', 'utf8'));
const binding = JSON.parse(readFileSync('node_modules/@rolldown/binding-wasm32-wasi/package.json', 'utf8'));
const bindingPackages = readdirSync('node_modules/@rolldown').filter((name) => name.startsWith('binding-')).sort();
const { parseAst } = await import('rolldown/parseAst');
const program = parseAst('export const answer = 40 + 2;', null, 'answer.js');
console.log('__ROLLDOWN_WASI__' + JSON.stringify({
  logical: logical.name + `@` + logical.version,
  binding: binding.name + `@` + binding.version,
  bindingPackages,
  bodyLength: program.body.length,
  nodeVersion: process.version
}));
process.exit(0);