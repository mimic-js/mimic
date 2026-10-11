const fs = require('node:fs');
const root = process.cwd().replace(/\/packages\/tool$/, '');
const receipt = `portable-optional ${process.platform} ${process.arch}`;
fs.writeFileSync(`${root}/optional.log`, `${receipt}\n`);
console.log(receipt);
