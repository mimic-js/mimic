import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test } from 'vitest';

import { PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN } from '../../src/runtime/modules/published-endpoint/service';

const serviceWorkerAsset = 'src/runtime/modules/published-endpoint/service-worker.js';
const serviceWorkerProgram = 'src/runtime/modules/published-endpoint/service-worker-program.js';

test('the committed service-worker.js equals what the build generates from its sources', () => {
  // The embedded Worker Transport is function source text, so regenerate it
  // under the build's own transpiler (tsx) rather than Vitest's.
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const expected = execFileSync(
    process.execPath,
    [tsxCli, 'scripts/build-runtime-assets.mjs', '--stdout'],
    { encoding: 'utf8' }
  );

  expect(
    readFileSync(serviceWorkerAsset, 'utf8'),
    `${serviceWorkerAsset} is stale; run \`pnpm build:package\` and commit the regenerated file.`
  ).toBe(expected);
});

test('the Service Worker program reads the token its owner declares instead of restating it', () => {
  const program = readFileSync(serviceWorkerProgram, 'utf8');

  expect(program).not.toContain(PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN);
  expect(program).toContain('PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN');
});
