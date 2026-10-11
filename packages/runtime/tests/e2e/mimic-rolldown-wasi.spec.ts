import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const angular21RolldownClaim = defineCompatibilityClaim({
  id: 'rolldown-1-0-0-rc-4-publisher-wasi-exact-graph',
  statement:
    'Angular 21.2.19 logical Rolldown 1.0.0-rc.4 installs and parses through its same-version publisher WASI binding',
  target: rolldownExactGraphTarget('1.0.0-rc.4')
});

const vite8RolldownClaim = defineCompatibilityClaim({
  id: 'rolldown-1-1-5-publisher-wasi-exact-graph',
  statement:
    'Vite 8.1.4 logical Rolldown 1.1.5 installs and parses through its same-version publisher WASI binding',
  target: rolldownExactGraphTarget('1.1.5')
});

const angular22RolldownClaim = defineCompatibilityClaim({
  id: 'rolldown-1-2-0-publisher-wasi-exact-graph',
  statement:
    'Angular 22.1.0 logical Rolldown 1.2.0 installs and parses through its same-version publisher WASI binding',
  target: rolldownExactGraphTarget('1.2.0')
});

const rolldownLines = [
  {
    claim: angular21RolldownClaim,
    version: '1.0.0-rc.4',
    bindingIntegrity:
      'sha512-wz7ohsKCAIWy91blZ/1FlpPdqrsm1xpcEOQVveWoL6+aSPKL4VUcoYmmzuLTssyZxRpEwzuIxL/GDsvpjaBtOw==',
    wasmSha256: '14f85bd53e4148b4690c8f4da7507a20036a9b845f18dec841642307fb623572',
    workerSha256: 'bef6f03bbf1362c3f62f74048788d27a0441da00fc01f294804ee33291a2222d'
  },
  {
    claim: vite8RolldownClaim,
    version: '1.1.5',
    bindingIntegrity:
      'sha512-VbQGPX2b4r48TAMIM2cjgluIM1HYutm4pcTEJsle7iEP7sB1dFqtPLBVbdLAZCxy1txCcPxf4QFf4v8uvltPqA==',
    wasmSha256: '76380fa3f831b46548fb332f961c5b0d21a57c2ad51495ad9c0da123ffac48ce',
    workerSha256: '9ab6d5481fff22d102d014a13eab3ad2411aeba7fde21682ec136bf4f305fdca'
  },
  {
    claim: angular22RolldownClaim,
    version: '1.2.0',
    bindingIntegrity:
      'sha512-rwdbUL465kisF24WEJLvP3JrEG6E5GRuIHt5wpMwHGERtHe4Wm2CIvtf5gTBgr2tGOHKh5NdKEAFS2VkOPE91g==',
    wasmSha256: 'fd413bab8b9b5ce523c7f59506aaede487da277066cbdc487033648ee705769a',
    workerSha256: '9ab6d5481fff22d102d014a13eab3ad2411aeba7fde21682ec136bf4f305fdca'
  }
] as const;

for (const line of rolldownLines) {
  test.describe(() => {
    test.use({ fixture: `rolldown-${line.version}` });

    test(line.claim.statement, async ({ stack }) => {
      expect(await stack.run('npm --version')).toEqual({ exitCode: 0, output: '11.18.0\n' });
      await stack.install('npm ci', { layer: false });

      const parse = await stack.run('node parse.mjs', { timeoutMs: 90_000 });
      expect(parse.exitCode, parse.output).toBe(0);
      const marker = '__ROLLDOWN_WASI__';
      const evidence = parse.output.split(/\r?\n/u).find((candidate) => candidate.startsWith(marker));
      expect(evidence, parse.output).toBeDefined();
      expect(JSON.parse(evidence!.slice(marker.length))).toEqual({
        logical: `rolldown@${line.version}`,
        binding: `@rolldown/binding-wasm32-wasi@${line.version}`,
        bindingPackages: ['binding-wasm32-wasi'],
        bodyLength: 1,
        nodeVersion: 'v22.22.3'
      });

      // npm selected the binding itself: the runtime reports process.arch "wasm32",
      // which satisfies the binding's own `cpu: ["wasm32"]` restriction.
      const binding = 'node_modules/@rolldown/binding-wasm32-wasi';
      const installState = JSON.parse(await stack.readFile('node_modules/.package-lock.json'));
      expect(installState.packages[binding]).toMatchObject({
        version: line.version,
        resolved: `https://registry.npmjs.org/@rolldown/binding-wasm32-wasi/-/binding-wasm32-wasi-${line.version}.tgz`,
        integrity: line.bindingIntegrity,
        cpu: ['wasm32']
      });
      expect((await stack.readdir('node_modules/@rolldown')).filter((name) => name.startsWith('binding-'))).toEqual([
        'binding-wasm32-wasi'
      ]);

      const wasm = await stack.digest(`${binding}/rolldown-binding.wasm32-wasi.wasm`);
      expect(wasm.sha256).toBe(line.wasmSha256);
      expect(wasm.byteLength).toBeGreaterThan(1_000_000);
      const worker = await stack.digest(`${binding}/wasi-worker-browser.mjs`);
      expect(worker.sha256).toBe(line.workerSha256);
      expect(worker.byteLength).toBeGreaterThan(1_000);
    });
  });
}

function rolldownExactGraphTarget(version: '1.0.0-rc.4' | '1.1.5' | '1.2.0') {
  return {
    kind: 'exact-graph',
    packages: {
      rolldown: version,
      '@rolldown/binding-wasm32-wasi': version
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: `compatibility/fixtures/rolldown-${version}/package-lock.json`
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node', entrypoint: 'parse.mjs' }
  } as const;
}
