import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const nestedInlineLifecycleClaim = defineCompatibilityClaim({
  id: 'process-execution-nested-inline-node-lifecycle-v1',
  statement:
    'Mimic preserves inline Node entries through the unmodified Nx 23.0.2 package lifecycle shell',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-nested-inline-node-lifecycle'
  }
});

test.use({ fixture: 'nx-23.0.2' });

test(nestedInlineLifecycleClaim.statement, async ({ stack }) => {
  // The lifecycle shell runs `node -e`; an inline entry must not leave a file behind or be taken for a path.
  const install = await stack.install('npm ci', { layer: false });
  expect(await stack.installedPackage('node_modules/nx')).toBe('nx@23.0.2');
  expect((await stack.readdir('node_modules/nx')).filter((entry) => entry.startsWith('.mimic-inline-'))).toEqual([]);
  expect(install.output).not.toContain('/node_modules/nx/-e');
});
