import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
const logical = JSON.parse(readFileSync('node_modules/rolldown/package.json', 'utf8'));
// The lockfile names no WASI binding; the Command Proxy linked the companion into rolldown's own node_modules.
const link = 'node_modules/rolldown/node_modules/@rolldown/binding-wasm32-wasi';
const binding = JSON.parse(readFileSync(`${link}/package.json`, 'utf8'));
const { parseAst } = await import('rolldown/parseAst');
const program = parseAst('export const answer = 40 + 2;', null, 'answer.js');
console.log('__ROLLDOWN_COMPANION__' + JSON.stringify({
  logical: `${logical.name}@${logical.version}`,
  binding: `${binding.name}@${binding.version}`,
  bindingPath: relative(process.cwd(), realpathSync(link)),
  // @rolldown/pluginutils is installed; no binding is.
  bindingPackages: existsSync('node_modules/@rolldown') ? readdirSync('node_modules/@rolldown').filter((name) => name.startsWith('binding-')) : [],
  bodyLength: program.body.length,
  nodeVersion: process.version
}));
process.exit(0);
