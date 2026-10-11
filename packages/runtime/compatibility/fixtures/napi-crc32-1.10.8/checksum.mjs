import { readFileSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { crc32, crc32c } from '@node-rs/crc32';
const logical = JSON.parse(readFileSync('node_modules/@node-rs/crc32/package.json', 'utf8'));
// @node-rs/crc32 sets no napi.packageName: its binding is named after the package itself.
const link = 'node_modules/@node-rs/crc32/node_modules/@node-rs/crc32-wasm32-wasi';
const binding = JSON.parse(readFileSync(`${link}/package.json`, 'utf8'));
console.log('__CRC32_COMPANION__' + JSON.stringify({
  logical: `${logical.name}@${logical.version}`,
  binding: `${binding.name}@${binding.version}`,
  bindingPath: relative(process.cwd(), realpathSync(link)),
  crc32: crc32('mimic').toString(16),
  crc32c: crc32c('mimic').toString(16),
  nodeVersion: process.version
}));
process.exit(0);
