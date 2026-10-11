import { ESBUILD_REPLACEMENT_LAUNCHER } from './browser-package-replacement-evidence';
import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';
import {
  readVite6ExactGraphEvidence,
  vite6ExactGraphReporterSource
} from './vite6-claim-evidence';
import { vite6DevSuiteVersionInputs } from './vite6-vanilla-fixture';
import { createViteSourceDevelopmentCases } from './vite-source-development-cases';
import { ViteDevSuite } from './vite-dev-suite';

const vanillaCompatibilityClaim = defineCompatibilityClaim({
  id: 'vanilla-vite-6-4-3-development-workflow',
  statement:
    'Vanilla Vite 6.4.3 preserves its upstream client session across JavaScript, CSS, syntax-error recovery, hard reload, stop, teardown, and reboot',
  target: {
    kind: 'exact-graph',
    packages: {
      picocolors: '1.1.1',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/vanilla-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const typescriptCompatibilityClaim = defineCompatibilityClaim({
  id: 'typescript-vite-6-4-3-development-workflow',
  statement:
    'TypeScript with Vite 6.4.3 preserves its upstream client session across typed transforms, updates, transform-error recovery, hard reload, stop, teardown, and reboot',
  target: {
    kind: 'exact-graph',
    packages: {
      picocolors: '1.1.1',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/typescript-vite-6.4.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const vanillaSsrCompatibilityClaim = defineCompatibilityClaim({
  id: 'vanilla-vite-6-4-3-ssr-frontier',
  statement:
    'Vanilla Vite 6.4.3 loads and renders /src/entry-server.js through the real Vite SSR pipeline after frozen installation',
  target: {
    ...vanillaCompatibilityClaim.target,
    execution: { command: 'node', entrypoint: 'ssrLoadModule /src/entry-server.js' }
  }
});

const viteSourceClaims = createViteSourceDevelopmentCases({
  vanilla: {
    claim: vanillaCompatibilityClaim,
    app: 'vanilla'
  },
  typescript: {
    claim: typescriptCompatibilityClaim
  }
});

const vite6DevSuite = new ViteDevSuite(vite6DevSuiteVersionInputs);

for (const claimCase of viteSourceClaims) vite6DevSuite.register(claimCase);

test.describe(() => {
  test.use({ fixture: 'vanilla-vite-6.4.3', app: 'ssr' });

  test(vanillaSsrCompatibilityClaim.statement, async ({ stack }) => {
    await stack.writeFile('ssr-runner.mjs', vanillaSsrRunnerSource());
    await stack.install();

    const execution = await stack.run('node ssr-runner.mjs');
    expect(execution.exitCode, execution.output).toBe(0);
    expect(readVite6ExactGraphEvidence(execution.output, 'VITE_SSR_EXACT_GRAPH')).toEqual({
      replacements: vanillaSsrCompatibilityClaim.target.replacements,
      esbuildBinaryPath: ESBUILD_REPLACEMENT_LAUNCHER,
      materializedPackages: ['picocolors@1.1.1', 'vite@6.4.3', 'esbuild@0.25.12', '@rollup/wasm-node@4.62.3']
    });
    expect(readSsrLifecycleEvidence(execution.output)).toEqual({
      viteVersion: '6.4.3',
      entrypoint: '/src/entry-server.js',
      input: { name: 'Mimic' },
      rendered: '<main><h1>Vite 6.4.3 SSR rendered Mimic</h1></main>',
      transformMarker: 'vite-ssr-transform',
      phases: [
        'runner-imported',
        'vite-server-created',
        'entry-transformed',
        'entry-loaded',
        'rendered',
        'vite-server-closed'
      ]
    });
  });
});

function vanillaSsrRunnerSource(): string {
  return String.raw`
import { createServer } from 'vite';

${vite6ExactGraphReporterSource(
  'VITE_SSR_EXACT_GRAPH',
  Object.keys(vanillaSsrCompatibilityClaim.target.replacements)
)}

const entrypoint = '/src/entry-server.js';
const input = { name: 'Mimic' };
const phases = ['runner-imported'];
const server = await createServer({
  root: process.cwd(),
  appType: 'custom',
  configFile: false,
  server: { middlewareMode: true },
  plugins: [
    {
      name: 'ssr-frontier-proof',
      transform(source, id, options) {
        if (id.endsWith(entrypoint) && options?.ssr === true) {
          phases.push('entry-transformed');
          return {
            code: source + "\nexport const viteSsrTransformMarker = 'vite-ssr-transform';",
            map: null
          };
        }
      }
    }
  ]
});
phases.push('vite-server-created');

let evidence;
try {
  const loaded = await server.ssrLoadModule(entrypoint);
  phases.push('entry-loaded');
  const rendered = loaded.render(input);
  phases.push('rendered');
  evidence = {
    viteVersion: vitePackage.version,
    entrypoint,
    input,
    rendered,
    transformMarker: loaded.viteSsrTransformMarker
  };
} finally {
  await server.close();
  phases.push('vite-server-closed');
}

console.log('VITE_SSR_LIFECYCLE', JSON.stringify({ ...evidence, phases }));
`;
}

function readSsrLifecycleEvidence(output: string): Readonly<{
  viteVersion: string;
  entrypoint: string;
  input: Readonly<{ name: string }>;
  rendered: string;
  transformMarker: string;
  phases: readonly string[];
}> {
  const prefix = 'VITE_SSR_LIFECYCLE ';
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`Vite SSR execution did not emit lifecycle evidence:\n${output}`);
  }
  const evidence: unknown = JSON.parse(line.slice(prefix.length));
  if (
    !isSsrRecord(evidence) ||
    typeof evidence.viteVersion !== 'string' ||
    typeof evidence.entrypoint !== 'string' ||
    !isSsrRecord(evidence.input) ||
    typeof evidence.input.name !== 'string' ||
    typeof evidence.rendered !== 'string' ||
    typeof evidence.transformMarker !== 'string' ||
    !Array.isArray(evidence.phases) ||
    !evidence.phases.every((phase) => typeof phase === 'string')
  ) {
    throw new Error(`Vite SSR lifecycle evidence has an invalid shape:\n${line}`);
  }
  return {
    viteVersion: evidence.viteVersion,
    entrypoint: evidence.entrypoint,
    input: { name: evidence.input.name },
    rendered: evidence.rendered,
    transformMarker: evidence.transformMarker,
    phases: evidence.phases
  };
}

function isSsrRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
