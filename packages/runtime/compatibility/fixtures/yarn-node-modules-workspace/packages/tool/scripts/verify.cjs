const fs = require('node:fs');
const root = process.cwd().replace(/\/packages\/tool$/, '');
const before = fs.readFileSync(`${root}/order.log`, 'utf8').trim();
fs.writeFileSync(`${root}/order.log`, `${before}\ntool\n`);
console.log('tool-after', before, process.cwd());
