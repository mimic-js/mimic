import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test, type Stack } from './stack-scenario';

const esbuildWasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'esbuild-0-25-12-publisher-wasi-exact-graph',
  statement:
    'Original esbuild 0.25.12 installs from its exact graph, runs its publisher WASI service, and writes splitting rebuilds through public Mimic VFS',
  target: {
    kind: 'exact-graph',
    packages: { esbuild: '0.25.12' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/esbuild-0.25.12/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node', entrypoint: 'build.mjs' }
  }
});

const esbuild0282WasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'esbuild-0-28-2-publisher-wasi-exact-graph',
  statement:
    'Original esbuild 0.28.2 installs from its exact graph and performs a real transform through its Publisher WASI Executable',
  target: {
    kind: 'exact-graph',
    packages: { esbuild: '0.28.2' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/esbuild-0.28.2/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node', entrypoint: 'transform.mjs' }
  }
});

const esbuild0281WasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'esbuild-0-28-1-publisher-wasi-exact-graph',
  statement:
    'Original esbuild 0.28.1 installs from its exact graph and performs useful API, CLI, and service work through its same-version Publisher WASI Executable',
  target: {
    kind: 'exact-graph',
    packages: { esbuild: '0.28.1' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/esbuild-0.28.1/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node', entrypoint: 'api-service.mjs' }
  }
});

const boundedOversizedWasiReadClaim = defineCompatibilityClaim({
  id: 'wasi-preview1-bounded-oversized-file-read-v1',
  statement:
    'Mimic completes bounded package-neutral WASI file reads while esbuild bundles a source larger than 1 MiB',
  target: {
    kind: 'runtime-capability',
    capability: 'wasi-preview1-bounded-oversized-file-read'
  }
});

const launcher = '/.mimic/bin/esbuild';

/** What an esbuild install leaves behind: the package itself, the launcher it recorded, and the executable it runs. */
async function replacementEvidence(stack: Stack, version: string) {
  expect(await stack.installedPackage('node_modules/esbuild')).toBe(`esbuild@${version}`);
  const recorded = /^var ESBUILD_BINARY_PATH = ("[^"]*");$/mu.exec(
    (await stack.readFile('node_modules/esbuild/lib/main.js')).split('\n', 1)[0]
  );
  expect(recorded && JSON.parse(recorded[1])).toBe(launcher);
  expect(await stack.exists('node_modules/@esbuild/wasi-preview1')).toBe(false);
  return stack.digest(`/.mimic/replacements/@esbuild/wasi-preview1/${version}/esbuild.wasm`);
}

test.describe(() => {
  test.use({ fixture: 'esbuild-0.25.12' });

  test(esbuildWasiCompatibilityClaim.statement, async ({ stack }) => {
    expect(await stack.run('npm --version')).toEqual({ exitCode: 0, output: '11.18.0\n' });
    await stack.install('npm ci', { layer: false });
    expect(await stack.installedPackage('node_modules/esbuild')).toBe('esbuild@0.25.12');

    // `build.mjs` builds, waits for `rebuild.trigger`, and builds again in the same context.
    const outputs = async () => {
      const files = await stack.listFiles('dist');
      return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await stack.readFile(`dist/${file}`)])));
    };
    const build = await stack.spawn('node build.mjs');
    await expect.poll(() => stack.exists('initial.ready'), { timeout: 60_000 }).toBe(true);
    const initial = await outputs();
    expect(Object.keys(initial).filter((file) => !file.startsWith('chunks/'))).toEqual(['admin.js', 'app.js']);
    expect(Object.keys(initial).filter((file) => file.startsWith('chunks/')).length).toBeGreaterThanOrEqual(2);
    const initialText = Object.values(initial).join('\n');
    for (const marker of ['APP_VALUE_BEFORE', 'USER_PLUGIN_MARKER', 'SHARED_CHUNK_MARKER', 'LAZY_CHUNK_MARKER']) {
      expect(initialText).toContain(marker);
    }

    await stack.writeFile(
      'src/app.js',
      (await stack.readFile('src/app.js')).replace('APP_VALUE_BEFORE', 'APP_VALUE_AFTER')
    );
    await stack.writeFile('rebuild.trigger', 'rebuild');
    await expect.poll(() => stack.exists('updated.ready'), { timeout: 60_000 }).toBe(true);
    const updated = await outputs();
    expect(updated['app.js']).toContain('APP_VALUE_AFTER');
    expect(updated['app.js']).not.toContain('APP_VALUE_BEFORE');
    const { exitCode, output } = await build.exit();
    expect(exitCode, output).toBe(0);
  });

  test('Original esbuild preserves a caller ESBUILD_BINARY_PATH through its real install lifecycle', async ({ stack }) => {
    await stack.install('npm ci', { layer: false });

    // The caller's binary is the installed wrapper with one line that records its use.
    const callerBin = `${stack.workdir}/caller/esbuild.cjs`;
    const marker = `${stack.workdir}/caller/invoked`;
    await stack.writeFile(
      callerBin,
      (await stack.readFile('node_modules/esbuild/bin/esbuild')).replace(
        '#!/usr/bin/env node\n',
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`
      )
    );
    const reinstall = await stack.run('npm ci', { env: { ESBUILD_BINARY_PATH: callerBin } });
    expect(reinstall.exitCode, reinstall.output).toBe(0);
    await stack.rm(marker);

    expect(await stack.run('node node_modules/esbuild/bin/esbuild --version')).toEqual({
      exitCode: 0,
      output: '0.25.12\n'
    });
    expect(await stack.exists(marker)).toBe(true);
    await stack.expectLockfileUnchanged();
  });
});

test.describe(() => {
  test.use({ fixture: 'esbuild-0.28.1' });

  test(esbuild0281WasiCompatibilityClaim.statement, async ({ stack }) => {
    await stack.install('npm ci', { layer: false });

    const api = await stack.run('node api-service.mjs');
    expect(api.exitCode, api.output).toBe(0);
    expect(JSON.parse(api.output)).toEqual({
      version: '0.28.1',
      nodeVersion: 'v22.22.3',
      transformCode: 'const answer = 42;\n',
      serviceOutput: expect.stringContaining('ESBUILD_0281_SERVICE_MARKER'),
      ambientBinaryPath: null
    });

    const cli = await stack.run('node node_modules/esbuild/bin/esbuild cli-entry.ts --bundle --outfile=cli-out.js --log-level=warning');
    expect(cli).toEqual({ exitCode: 0, output: '' });
    expect(await stack.readFile('cli-out.js')).toContain('ESBUILD_0281_CLI_MARKER');

    expect(await replacementEvidence(stack, '0.28.1')).toEqual({
      byteLength: 20_205_560,
      sha256: '4ad172b4e6948513a3180b0bef3dec875db7ae3ee76af893bbdafb006cd60aec'
    });
  });
});

test.describe(() => {
  test.use({ fixture: 'esbuild-0.28.2' });

  test(esbuild0282WasiCompatibilityClaim.statement, async ({ stack }) => {
    await stack.install('npm ci', { layer: false });
    const transform = await stack.run('node transform.mjs');
    expect(transform.exitCode, transform.output).toBe(0);
    expect(JSON.parse(transform.output)).toEqual({ version: '0.28.2', code: 'const answer = 42;\n', ambientBinaryPath: null });
  });

  test(boundedOversizedWasiReadClaim.statement, async ({ stack }) => {
    const oversized = [
      `export const oversizedPayload = '${'x'.repeat(1_050_000)}';`,
      "export const marker = 'OVERSIZED_WASI_READ_MARKER';"
    ].join('\n');
    await stack.writeFile('oversized.ts', oversized);
    await stack.install('npm ci', { layer: false });

    const bundle = await stack.run('node bundle.mjs');
    expect(bundle.exitCode, bundle.output).toBe(0);
    expect(JSON.parse(bundle.output)).toEqual({
      version: '0.28.2',
      inputByteLength: new TextEncoder().encode(oversized).byteLength,
      outputByteLength: expect.any(Number),
      outputExceedsReadBound: true,
      containsMarker: true,
      ambientBinaryPath: null
    });
    await replacementEvidence(stack, '0.28.2');
  });

  test('Original esbuild 0.28.2 records the replacement launcher and runs its same-version publisher WASI executable', async ({ stack }) => {
    await stack.install('npm ci', { layer: false });
    expect((await stack.run('node transform.mjs')).exitCode).toBe(0);
    const executable = await replacementEvidence(stack, '0.28.2');
    expect(executable.byteLength).toBeGreaterThan(1_000_000);
    expect(executable.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
