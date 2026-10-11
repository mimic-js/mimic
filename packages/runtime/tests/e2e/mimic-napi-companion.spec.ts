import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

/**
 * A package built with NAPI-RS that publishes a WASI binding but no longer
 * lists it in its optionalDependencies: npm installs no binding at all, and
 * the Command Proxy installs the one the package's own loader falls back to,
 * derived from the package's `napi` metadata, as a companion.
 */

const rolldownCompanionClaim = defineCompatibilityClaim({
  id: 'rolldown-1-2-12-napi-companion-exact-graph',
  statement:
    'Rolldown 1.2.12, the line Vite 8.3.2 resolves, lists no WASI binding and parses through the same-version @rolldown/binding-wasm32-wasi installed as its companion',
  target: npmExactGraph('rolldown-1.2.12', { rolldown: '1.2.12' }, 'node parse.mjs')
});

const crc32CompanionClaim = defineCompatibilityClaim({
  id: 'node-rs-crc32-1-10-8-napi-companion-exact-graph',
  statement:
    '@node-rs/crc32 1.10.8, whose napi metadata names no binding scope, checksums through the same-version @node-rs/crc32-wasm32-wasi installed as its companion',
  target: npmExactGraph('napi-crc32-1.10.8', { '@node-rs/crc32': '1.10.8' }, 'node checksum.mjs')
});

const companionLines = [
  {
    claim: rolldownCompanionClaim,
    fixture: 'rolldown-1.2.12',
    source: 'rolldown',
    companion: '@rolldown/binding-wasm32-wasi',
    version: '1.2.12',
    wasm: 'rolldown-binding.wasm32-wasi.wasm',
    wasmSha256: '0d2266aee0629625f53ce1ecdbb79f08b8583a5b84f6311e17df8e4690889bf4',
    workerSha256: 'c75b826181d93cfa9df7a5e5212a353ad965be363149db634478c618196fe30c',
    command: 'node parse.mjs',
    marker: '__ROLLDOWN_COMPANION__',
    evidence: {
      logical: 'rolldown@1.2.12',
      binding: '@rolldown/binding-wasm32-wasi@1.2.12',
      bindingPath:
        'node_modules/.mimic/companions/@rolldown/binding-wasm32-wasi/1.2.12/node_modules/@rolldown/binding-wasm32-wasi',
      bindingPackages: [],
      bodyLength: 1,
      nodeVersion: 'v22.22.3'
    }
  },
  {
    claim: crc32CompanionClaim,
    fixture: 'napi-crc32-1.10.8',
    source: '@node-rs/crc32',
    companion: '@node-rs/crc32-wasm32-wasi',
    version: '1.10.8',
    wasm: 'crc32.wasm32-wasi.wasm',
    wasmSha256: '08c4f744aca34f74ff700f18ef02a2dd20acea922d1b8a8e809b97c43d33d81a',
    workerSha256: '6d23efa1dd0c54c8941089e718e9a85494fb5d847cac092758547d34580c765b',
    command: 'node checksum.mjs',
    marker: '__CRC32_COMPANION__',
    evidence: {
      logical: '@node-rs/crc32@1.10.8',
      binding: '@node-rs/crc32-wasm32-wasi@1.10.8',
      bindingPath:
        'node_modules/.mimic/companions/@node-rs/crc32-wasm32-wasi/1.10.8/node_modules/@node-rs/crc32-wasm32-wasi',
      crc32: 'c1254417',
      crc32c: '7a699c40',
      nodeVersion: 'v22.22.3'
    }
  }
] as const;

for (const line of companionLines) {
  test.describe(() => {
    test.use({ fixture: line.fixture });

    test(line.claim.statement, async ({ stack }) => {
      test.setTimeout(600_000);
      await stack.install('npm ci', { layer: false });

      // npm installed what the lockfile names: the package, and no binding of it.
      const installState = JSON.parse(await stack.readFile('node_modules/.package-lock.json'));
      expect(Object.keys(installState.packages).filter((path) => path.includes('-wasm32-'))).toEqual([]);
      expect(Object.keys(installState.packages).filter((path) => path.includes('wasm-runtime'))).toEqual([]);

      // The companion came from the registry unchanged, with its own dependencies beside it.
      const companionRoot = `node_modules/.mimic/companions/${line.companion}/${line.version}/node_modules`;
      expect(await stack.installedPackage(`${companionRoot}/${line.companion}`)).toBe(`${line.companion}@${line.version}`);
      expect(await stack.exists(`${companionRoot}/@napi-rs/wasm-runtime/package.json`)).toBe(true);
      const wasm = await stack.digest(`${companionRoot}/${line.companion}/${line.wasm}`);
      expect(wasm.sha256).toBe(line.wasmSha256);
      expect(wasm.byteLength).toBeGreaterThan(10_000);
      const worker = await stack.digest(`${companionRoot}/${line.companion}/wasi-worker-browser.mjs`);
      expect(worker.sha256).toBe(line.workerSha256);

      const run = await stack.run(line.command, { timeoutMs: 180_000 });
      expect(run.exitCode, run.output).toBe(0);
      expect(evidenceOf(run.output, line.marker)).toEqual(line.evidence);

      // A later install prunes the link the manager did not make; the Command Proxy links the same companion again.
      const reinstall = await stack.run('npm install', { timeoutMs: 180_000 });
      expect(reinstall.exitCode, reinstall.output).toBe(0);
      await stack.expectLockfileUnchanged();
      const again = await stack.run(line.command, { timeoutMs: 180_000 });
      expect(again.exitCode, again.output).toBe(0);
      expect(evidenceOf(again.output, line.marker)).toEqual(line.evidence);
    });
  });
}

function evidenceOf(output: string, marker: string): unknown {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(marker));
  expect(line, output).toBeDefined();
  return JSON.parse(line!.slice(marker.length));
}
