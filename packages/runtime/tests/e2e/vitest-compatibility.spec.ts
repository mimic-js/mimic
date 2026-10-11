import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'vitest-5-0-3-cart',
  statement: 'Vitest 5.0.3 runs a TypeScript test suite to completion',
  target: npmExactGraph('vitest-5-cart', { vitest: '5.0.3' }, 'npm test')
});

test.use({ fixture: 'vitest-5-cart' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const result = await stack.run('npm test', { timeoutMs: 240_000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output.replace(/\x1b\[[0-9;]*m/gu, '')).toMatch(/Tests\s+6 passed/);
});
