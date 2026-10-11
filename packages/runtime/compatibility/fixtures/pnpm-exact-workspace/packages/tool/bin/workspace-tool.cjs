const odd = require('is-odd');
const number = require('is-number');

console.log(`workspace-bin:${odd(3)}:${number(2)}:${process.argv[2]}`);
