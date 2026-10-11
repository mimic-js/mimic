const fs = require('node:fs');
const root = process.cwd().replace(/\/packages\/dependency$/, '');
const before = fs.existsSync(`${root}/order.log`) ? fs.readFileSync(`${root}/order.log`, 'utf8') : '';
fs.writeFileSync(`${root}/order.log`, `${before}dependency\n`);
console.log('dependency-first', process.cwd());
