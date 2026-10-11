import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'jest-30-5-2-cart',
  statement: 'Jest 30.5.2 runs a CommonJS test suite in its node environment',
  target: npmExactGraph('jest-30-cart', { jest: '30.5.2' }, 'npm test')
});

test.use({ fixture: 'jest-30-cart' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const result = await stack.run('npm test', { timeoutMs: 240_000 });
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toMatch(/Tests:\s+2 passed/);
});
