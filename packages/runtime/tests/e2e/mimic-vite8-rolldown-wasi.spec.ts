import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const vite8RolldownWasiClaim = defineCompatibilityClaim({
  id: 'vite-8-1-4-rolldown-wasi-exact-graph',
  statement:
    'Vite 8.1.4 completes its version CLI and Rolldown 1.1.5 selects its same-version publisher WASI binding through Mimic',
  target: {
    kind: 'exact-graph',
    packages: {
      vite: '8.1.4',
      rolldown: '1.1.5',
      '@rolldown/binding-wasm32-wasi': '1.1.5'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/vite-8.1.4/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node', entrypoint: 'parse.mjs' }
  }
});

test.use({ fixture: 'vite-8.1.4' });

test(vite8RolldownWasiClaim.statement, async ({ stack }) => {
  const install = await stack.install('npm ci', { layer: false });
  expect(install.output).not.toContain('[rolldown] Downloading');

  const viteCli = await stack.run('node vite-version.mjs --version', { timeoutMs: 30_000 });
  expect(viteCli.exitCode, viteCli.output).toBe(0);
  expect(viteCli.output).toContain('vite/8.1.4');

  const parse = await stack.run('node parse.mjs', { timeoutMs: 60_000 });
  expect(parse.exitCode, parse.output).toBe(0);
  expect(parse.output).not.toContain('[rolldown] Downloading');
  expect(JSON.parse(parse.output)).toEqual({
    rolldown: 'rolldown@1.1.5',
    binding: '@rolldown/binding-wasm32-wasi@1.1.5',
    bindingPackages: ['binding-wasm32-wasi'],
    bodyLength: 1,
    nodeVersion: 'v22.22.3'
  });

  const binding = 'node_modules/@rolldown/binding-wasm32-wasi';
  expect((await stack.readdir('node_modules/@rolldown')).filter((name) => name.startsWith('binding-'))).toEqual([
    'binding-wasm32-wasi'
  ]);
  expect(JSON.parse(await stack.readFile('node_modules/.package-lock.json')).packages[binding]).toMatchObject({
    version: '1.1.5',
    integrity: 'sha512-VbQGPX2b4r48TAMIM2cjgluIM1HYutm4pcTEJsle7iEP7sB1dFqtPLBVbdLAZCxy1txCcPxf4QFf4v8uvltPqA=='
  });
  expect((await stack.digest(`${binding}/rolldown-binding.wasm32-wasi.wasm`)).byteLength).toBeGreaterThan(1_000_000);
});
