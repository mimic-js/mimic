const fs = require('node:fs');
const odd = require('is-odd');
const number = require('is-number');

fs.appendFileSync(
  '../../lifecycle.log',
  `workspace-lifecycle:${odd(3)}:${number(2)}:${process.env.npm_lifecycle_event}\n`
);
