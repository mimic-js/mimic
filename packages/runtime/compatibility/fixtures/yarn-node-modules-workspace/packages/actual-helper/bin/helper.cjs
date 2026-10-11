const fs = require('node:fs');
const root = process.cwd().replace(/\/packages\/tool$/, '');
const receipt = `peer-helper ${process.argv[2]}`;
fs.writeFileSync(`${root}/peer.log`, `${receipt}\n`);
console.log(receipt);
