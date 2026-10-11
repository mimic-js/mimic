import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  startCleanExternalConsumer,
  typecheckCleanConsumer,
  type CleanExternalConsumerWindow
} from './clean-external-consumer-harness';

type CleanExternalConsumerBridge =
  CleanExternalConsumerWindow['__cleanExternalConsumer'];
type CleanExternalConsumerRuntime = Awaited<
  ReturnType<CleanExternalConsumerBridge['Mimic']['boot']>
>;
type CleanExternalConsumerProcess = Awaited<
  ReturnType<CleanExternalConsumerRuntime['spawn']>
>;
type CleanExternalConsumerEndpoint =
  CleanExternalConsumerRuntime['endpoints']['current'][number];

const cleanExternalConsumerClaim = defineCompatibilityClaim({
  id: 'mimic-clean-external-consumer-v1',
  statement:
    'A clean consumer installs the packed @mimic-js/runtime artifact and uses its public Mimic API to mount, spawn, publish, terminate, tear down, and reboot a generic Node HTTP server without fallback paths',
  target: {
    kind: 'runtime-capability',
    capability: 'mimic-clean-external-consumer'
  }
});

test(cleanExternalConsumerClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const requestedUrls: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  page.on('request', (request) => requestedUrls.push(request.url()));

  const consumer = await startCleanExternalConsumer();
  try {
    expect(consumer.consumerRoot).not.toBe('');
    expect(consumer.packedArtifact).toContain('mimic-js-runtime-');
    await typecheckCleanConsumer(consumer.consumerRoot, publicSurfaceConsumerSource);
    await page.goto(consumer.url, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect.poll(() => page.evaluate(() => Reflect.has(window, '__cleanExternalConsumer'))).toBe(true);

    const receipt = await page.evaluate(async () => {
      const bridge = readBridge();
      const first = await runCycle('first', '/home/clean-external-consumer-first');
      const reboot = await runCycle('reboot', '/home/clean-external-consumer-reboot');

      return { first, reboot };

      async function runCycle(run: 'first' | 'reboot', workdir: string) {
        const runtime = await bridge.Mimic.boot({ workdir });
        let tornDown = false;
        try {
          if (runtime.workdir !== workdir) {
            throw new Error(`Public Mimic boot changed the canonical workdir from ${workdir} to ${runtime.workdir}`);
          }
          await runtime.fs.mount({
            'server.mjs': {
              file: { contents: serverSource(run) }
            }
          });

          const process = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`], { cwd: runtime.workdir });
          const output = collectOutput(process);
          const endpoint = await waitForEndpoint(runtime, 60_000);
          const response = await runtime.endpoints.fetch(new URL('runtime-proof', endpoint.url), { cache: 'no-store' });
          const body = await response.text();
          process.kill('SIGTERM');
          const exitCode = await waitForExit(process, output.text, 30_000);
          const processOutput = await output.done;
          await waitForEndpointRemoval(runtime, endpoint.url, 10_000);
          await runtime.teardown();
          tornDown = true;

          return {
            workdir: runtime.workdir,
            endpoint: { port: endpoint.port, sameOrigin: new URL(endpoint.url).origin === location.origin },
            response: {
              status: response.status,
              owner: response.headers.get('x-external-consumer-run'),
              body
            },
            termination: { exitCode, output: processOutput, endpointUnpublished: true },
            tornDown
          };
        } finally {
          if (!tornDown) await runtime.teardown();
        }
      }

      function readBridge(): CleanExternalConsumerBridge {
        const candidate = (
          globalThis as typeof globalThis & { readonly __cleanExternalConsumer?: unknown }
        ).__cleanExternalConsumer;
        if (!isConsumerBridge(candidate)) {
          throw new Error('Clean external consumer page did not expose window.__cleanExternalConsumer.Mimic');
        }
        return candidate;
      }

      function isConsumerBridge(
        value: unknown
      ): value is CleanExternalConsumerBridge {
        if (!isRecord(value)) return false;
        const Mimic = value.Mimic;
        return (
          typeof Mimic === 'function' &&
          typeof (Mimic as { readonly boot?: unknown }).boot === 'function'
        );
      }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }

      function serverSource(run: 'first' | 'reboot'): string {
        return [
          "import http from 'node:http';",
          '',
          `const run = ${JSON.stringify(run)};`,
          'const server = http.createServer((request, response) => {',
          "  if (request.url !== '/runtime-proof') { response.writeHead(404); response.end('not found'); return; }",
          "  response.writeHead(200, { 'content-type': 'text/plain', 'x-external-consumer-run': run });",
          "  response.end('external-consumer:' + run);",
          '});',
          "server.listen(4111, '127.0.0.1', () => console.log('external-consumer-server-ready:' + run));"
        ].join('\n');
      }

      function collectOutput(
        process: CleanExternalConsumerProcess
      ): Readonly<{ done: Promise<string>; text(): string }> {
        let text = '';
        const done = Promise.all([read(process.stdout), read(process.stderr)]).then(() => text);
        return { done, text: () => text };

        async function read(stream: ReadableStream<Uint8Array>): Promise<void> {
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              text += decoder.decode(value, { stream: !done });
              if (done) return;
            }
          } finally {
            reader.releaseLock();
          }
        }
      }

      async function waitForEndpoint(
        runtime: CleanExternalConsumerRuntime,
        timeoutMs: number
      ): Promise<CleanExternalConsumerEndpoint> {
        const current = runtime.endpoints.current[0];
        if (current) return current;
        return new Promise<CleanExternalConsumerEndpoint>((resolve, reject) => {
          let unsubscribe: (() => void) | undefined;
          const timer = setTimeout(() => {
            unsubscribe?.();
            reject(new Error(`Timed out waiting for the Published Endpoint after ${timeoutMs}ms`));
          }, timeoutMs);
          unsubscribe = runtime.endpoints.on('published', (endpoint) => {
            clearTimeout(timer);
            unsubscribe?.();
            resolve(endpoint);
          });
        });
      }

      async function waitForEndpointRemoval(
        runtime: CleanExternalConsumerRuntime,
        endpointUrl: string,
        timeoutMs: number
      ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (runtime.endpoints.current.every((endpoint) => endpoint.url !== endpointUrl)) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Published Endpoint remained live after process termination: ${endpointUrl}`);
      }

      async function waitForExit(
        process: CleanExternalConsumerProcess,
        output: () => string,
        timeoutMs: number
      ): Promise<number> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            process.exit,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Server process did not stop within ${timeoutMs}ms:\n${output()}`)),
                timeoutMs
              );
            })
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    });

    for (const cycle of [receipt.first, receipt.reboot]) {
      expect(cycle.endpoint).toEqual({ port: 4111, sameOrigin: true });
      expect(cycle.response).toEqual({
        status: 200,
        owner: cycle === receipt.first ? 'first' : 'reboot',
        body: `external-consumer:${cycle === receipt.first ? 'first' : 'reboot'}`
      });
      expect(cycle.termination.exitCode, cycle.termination.output).toBe(143);
      expect(cycle.termination.output).toContain(`external-consumer-server-ready:${cycle === receipt.first ? 'first' : 'reboot'}`);
      expect(cycle.termination.endpointUnpublished).toBe(true);
      expect(cycle.tornDown).toBe(true);
    }

    const evidence = [
      receipt.first.termination.output,
      receipt.reboot.termination.output,
      ...consoleErrors,
      ...pageErrors,
      ...requestFailures,
      ...requestedUrls
    ].join('\n');
    const forbiddenEvidence = [
      'falling back to registered command adapter',
      'registered-command-adapter',
      'esm.sh',
      'vfsPreviewFallback',
      '/src/runtime',
      '../src/runtime',
      '/tests/e2e'
    ];
    expect(forbiddenEvidence.filter((marker) => evidence.includes(marker))).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(requestFailures).toEqual([]);
  } finally {
    await consumer.close();
  }
});

/**
 * A TypeScript consumer of every public type, compiled against the packed
 * declarations: it fails to compile when the surface grows a member, loses
 * one, or names a type the package does not ship.
 */
const publicSurfaceConsumerSource = `import {
  Mimic,
  MimicProcessCrashError,
  type BootOptions,
  type DirentLike,
  type EmbedderPolicy,
  type FileStatLike,
  type FileSystemAPI,
  type FileSystemTree,
  type FileSystemTreeNode,
  type MimicProcess,
  type MimicProcessCrashErrorCode,
  type PublishedEndpoint,
  type PublishedEndpointCollection,
  type SpawnOptions
} from '@mimic-js/runtime';

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const surface: [
  Exactly<keyof MimicProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'exit' | 'kill'>,
  Exactly<keyof PublishedEndpoint, 'port' | 'url'>,
  Exactly<keyof PublishedEndpointCollection, 'current' | 'on' | 'fetch'>,
  Exactly<keyof SpawnOptions, 'cwd' | 'env'>,
  Exactly<keyof BootOptions, 'workdir' | 'embedderPolicy' | 'previewOrigin'>,
  Exactly<
    keyof FileSystemAPI,
    | 'revision'
    | 'readFile'
    | 'writeFile'
    | 'readdir'
    | 'mkdir'
    | 'rm'
    | 'rename'
    | 'stat'
    | 'lstat'
    | 'exists'
    | 'symlink'
    | 'readlink'
    | 'realpath'
    | 'mount'
    | 'export'
  >,
  Exactly<MimicProcessCrashErrorCode, 'PROCESS_CRASH'>,
  Exactly<EmbedderPolicy, 'require-corp' | 'credentialless'>
] = [true, true, true, true, true, true, true, true];

export async function run(options: BootOptions): Promise<number> {
  const container = await Mimic.boot(options);
  try {
    const tree: FileSystemTree = {
      'index.js': { file: { contents: new Uint8Array([10]) }, mtimeMs: 0 },
      lib: { directory: {} },
      link: { symlink: { target: 'index.js' } }
    };
    await container.fs.mount(tree);
    const exported: FileSystemTree = await container.fs.export();
    const node: FileSystemTreeNode | undefined = exported['index.js'];
    const archive: Uint8Array = await container.fs.export(undefined, { format: 'zip' });
    const stat: FileStatLike = await container.fs.stat('index.js');
    const dirents = (await container.fs.readdir('.', { withFileTypes: true })).filter(
      (entry): entry is DirentLike => typeof entry !== 'string'
    );
    const revision: number = container.fs.revision;
    console.log(node, archive.byteLength, stat.mtimeMs, dirents.length, revision);
    const endpoints: readonly PublishedEndpoint[] = container.endpoints.current;
    const unsubscribe = container.endpoints.on('published', ({ port, url }) => console.log(port, url, endpoints));
    unsubscribe();
    const process: MimicProcess = await container.spawn('node', ['index.js'], { cwd: container.workdir, env: { A: '1' } });
    const writer = process.stdin.getWriter();
    await writer.close();
    await Promise.all([process.stdout.pipeTo(new WritableStream()), process.stderr.pipeTo(new WritableStream())]);
    process.kill('SIGINT');
    return await process.exit;
  } catch (error) {
    if (error instanceof MimicProcessCrashError) {
      const code: 'PROCESS_CRASH' = error.code;
      console.log(code, error.reason);
      return error.pid;
    }
    throw error;
  } finally {
    await container.teardown();
  }
}

export function removed(process: MimicProcess, endpoint: PublishedEndpoint, fs: FileSystemAPI): void {
  // @ts-expect-error The merged output is not public.
  void process.output;
  // @ts-expect-error The stdin alias is not public.
  void process.input;
  // @ts-expect-error The opaque route is not public.
  void endpoint.routeId;
  // @ts-expect-error The virtual address is not public.
  void endpoint.address;
  // @ts-expect-error Programs change permissions through node:fs.
  void fs.chmod;
}
`;
