import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import type { Mimic } from '@mimic-js/runtime';

const runFile = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const externalConsumerPrefix = 'mimic-clean-consumer-';

/**
 * The page served by this harness assigns the package's public entry point to
 * `window.__cleanExternalConsumer.Mimic`. Tests can import this
 * type and use that bridge in `page.evaluate` without reaching into repository
 * source paths.
 */
export type CleanExternalConsumerWindow = Window &
  typeof globalThis & {
    readonly __cleanExternalConsumer: Readonly<{
      readonly Mimic: typeof Mimic;
    }>;
  };

export type CleanExternalConsumerHarness = Readonly<{
  url: string;
  consumerRoot: string;
  packedArtifact: string;
  close(): Promise<void>;
}>;

/**
 * Packs this repository, installs that tarball in a separate npm consumer, and
 * serves only the consumer's entry files and installed dependencies. Nothing
 * in the browser module graph references this repository's source tree.
 */
export async function startCleanExternalConsumer(): Promise<CleanExternalConsumerHarness> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), externalConsumerPrefix));
  const packedDirectory = join(workspaceRoot, 'packed');
  const consumerRoot = join(workspaceRoot, 'consumer');
  let server: Server | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];

    if (server) {
      try {
        await closeServer(server);
      } catch (error) {
        errors.push(error);
      }
      server = undefined;
    }

    try {
      await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Clean external consumer cleanup failed.');
  };

  try {
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    // Playwright's shared web server already built the package. Re-running
    // prepack here would empty dist while concurrent browser claims use it.
    await runFile('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', packedDirectory], {
      cwd: canonicalRepositoryRoot,
      maxBuffer: 10 * 1024 * 1024
    });

    const packedArtifact = await findPackedArtifact(packedDirectory);
    await writeConsumerFiles(consumerRoot);
    await runFile(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--cache',
        join(workspaceRoot, 'npm-cache'),
        packedArtifact
      ],
      { cwd: consumerRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    await writeConsumerIndex(consumerRoot);

    const canonicalConsumerRoot = await realpath(consumerRoot);
    const canonicalPackedArtifact = await realpath(packedArtifact);
    await assertExternalInstalledPackage(canonicalConsumerRoot, canonicalRepositoryRoot);
    server = await startConsumerServer(canonicalConsumerRoot);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Clean external consumer server did not bind a TCP address.');
    }

    return Object.freeze({
      url: `http://127.0.0.1:${address.port}/`,
      consumerRoot: canonicalConsumerRoot,
      packedArtifact: canonicalPackedArtifact,
      close
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Clean external consumer setup and cleanup both failed.');
    }
    throw error;
  }
}

async function findPackedArtifact(packedDirectory: string): Promise<string> {
  const entries = await readdir(packedDirectory, { withFileTypes: true });
  const artifacts = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'));
  if (artifacts.length !== 1) {
    throw new Error(`Expected exactly one packed artifact in ${packedDirectory}, found ${artifacts.length}.`);
  }
  return join(packedDirectory, artifacts[0].name);
}

async function writeConsumerFiles(consumerRoot: string): Promise<void> {
  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'clean-mimic-consumer', private: true, type: 'module' }, null, 2)}\n`
  );
  await writeFile(
    join(consumerRoot, 'consumer.js'),
    "import { Mimic } from '@mimic-js/runtime';\n\nwindow.__cleanExternalConsumer = Object.freeze({ Mimic });\n"
  );
}

async function writeConsumerIndex(consumerRoot: string): Promise<void> {
  const installedManifest: unknown = JSON.parse(
    await readFile(join(consumerRoot, 'node_modules/@mimic-js/runtime/package.json'), 'utf8')
  );
  const browserEntry = publicBrowserEntry(installedManifest);
  const importMap = JSON.stringify({
    imports: {
      '@mimic-js/runtime': `/node_modules/@mimic-js/runtime/${browserEntry.slice(2)}`
    }
  });
  await writeFile(
    join(consumerRoot, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Clean Mimic consumer</title><script type="importmap">${importMap}</script></head><body><main id="consumer-root">clean external consumer</main><script type="module" src="/consumer.js"></script></body></html>\n`
  );
}

function publicBrowserEntry(manifest: unknown): string {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Installed @mimic-js/runtime package manifest must be an object.');
  }
  const exportsField = Reflect.get(manifest, 'exports');
  const publicEntry =
    exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
      ? Reflect.get(exportsField, '.')
      : undefined;
  const browserEntry =
    publicEntry !== null && typeof publicEntry === 'object' && !Array.isArray(publicEntry)
      ? Reflect.get(publicEntry, 'browser')
      : undefined;
  if (typeof browserEntry !== 'string' || !browserEntry.startsWith('./')) {
    throw new Error('Installed @mimic-js/runtime package must expose a relative public browser entry.');
  }
  return browserEntry;
}

async function assertExternalInstalledPackage(consumerRoot: string, canonicalRepositoryRoot: string): Promise<void> {
  const installedPackageRoot = await realpath(join(consumerRoot, 'node_modules', '@mimic-js/runtime'));
  if (isWithin(canonicalRepositoryRoot, installedPackageRoot)) {
    throw new Error(`Clean consumer resolved @mimic-js/runtime inside the repository: ${installedPackageRoot}`);
  }
  if (!isWithin(consumerRoot, installedPackageRoot)) {
    throw new Error(`Clean consumer resolved @mimic-js/runtime outside its temporary package: ${installedPackageRoot}`);
  }
}

function startConsumerServer(consumerRoot: string): Promise<Server> {
  const server = createServer((request, response) => {
    void serveConsumerRequest(consumerRoot, request.url ?? '/', request.method ?? 'GET', response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'Clean consumer server failed.');
    });
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveServer(server);
    });
  });
}

async function serveConsumerRequest(
  consumerRoot: string,
  requestUrl: string,
  method: string,
  response: import('node:http').ServerResponse
): Promise<void> {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');

  if (method !== 'GET' && method !== 'HEAD') {
    response.statusCode = 405;
    response.end();
    return;
  }

  const path = consumerPath(consumerRoot, requestUrl);
  if (!path) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    const contents = await readFile(path);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentType(path));
    if (method === 'HEAD') response.end();
    else response.end(contents);
  } catch (error: unknown) {
    if (isMissing(error)) {
      response.statusCode = 404;
      response.end();
      return;
    }
    throw error;
  }
}

function consumerPath(consumerRoot: string, requestUrl: string): string | undefined {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://consumer.invalid').pathname);
  } catch {
    return undefined;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relativePath === 'index.html' || relativePath === 'consumer.js') return join(consumerRoot, relativePath);
  if (!relativePath.startsWith('node_modules/')) return undefined;

  const candidate = resolve(consumerRoot, relativePath);
  return isWithin(consumerRoot, candidate) ? candidate : undefined;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function contentType(path: string): string {
  switch (extname(basename(path))) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
    server.closeAllConnections();
  });
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export type BundledConsumerKind = 'vite-dev' | 'vite-preview' | 'webpack';

export type BundledConsumerHarness = CleanExternalConsumerHarness &
  Readonly<{
    /**
     * Serves the same built consumer from another origin whose responses lack
     * one of the headers the runtime needs. Only a consumer this harness
     * serves itself, the webpack one, can be served this way.
     */
    serveWithout(headers: 'cross-origin-isolation' | 'service-worker-allowed'): Promise<string>;
  }>;

const consumerEntrySource =
  "import { Mimic } from '@mimic-js/runtime';\n\nwindow.__cleanExternalConsumer = Object.freeze({ Mimic });\n";
const consumerDocument = (script: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Bundled Mimic consumer</title></head><body><main id="consumer-root">bundled consumer</main>${script}</body></html>\n`;

/**
 * Packs this package, installs the tarball and a bundler from the registry in
 * a separate npm consumer, and serves the consumer the way its bundler does:
 * Vite's development server, Vite's preview of a production build, or a
 * webpack 5 production build behind a static server. The Vite consumers get
 * their headers from the package's own plugin.
 */
export async function startBundledConsumer(kind: BundledConsumerKind): Promise<BundledConsumerHarness> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), externalConsumerPrefix));
  const packedDirectory = join(workspaceRoot, 'packed');
  const consumerRoot = join(workspaceRoot, 'consumer');
  const servers: Server[] = [];
  let bundlerServer: ChildProcess | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    if (bundlerServer && bundlerServer.exitCode === null) {
      const exited = new Promise((resolveExit) => bundlerServer?.once('exit', resolveExit));
      bundlerServer.kill('SIGTERM');
      await exited;
    }
    for (const server of servers.splice(0)) {
      try {
        await closeServer(server);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Bundled consumer cleanup failed.');
  };

  try {
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    await runFile('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', packedDirectory], {
      cwd: canonicalRepositoryRoot,
      maxBuffer: 10 * 1024 * 1024
    });
    const packedArtifact = await findPackedArtifact(packedDirectory);
    await mkdir(join(consumerRoot, 'src'), { recursive: true });
    await writeFile(
      join(consumerRoot, 'package.json'),
      `${JSON.stringify({ name: 'bundled-mimic-consumer', private: true, type: 'module' }, null, 2)}\n`
    );
    await writeFile(join(consumerRoot, 'src/main.js'), consumerEntrySource);
    // The bundler comes from the shared npm cache; only the package under test is always fresh.
    await runFile(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        packedArtifact,
        kind === 'webpack' ? 'webpack@^5' : 'vite@^6'
      ],
      { cwd: consumerRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    const canonicalConsumerRoot = await realpath(consumerRoot);
    await assertExternalInstalledPackage(canonicalConsumerRoot, canonicalRepositoryRoot);

    const serveBuilt = async (headers: Readonly<Record<string, string>>): Promise<string> => {
      const server = await startStaticServer(join(canonicalConsumerRoot, 'dist'), headers);
      servers.push(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Bundled consumer server did not bind a TCP address.');
      }
      return `http://127.0.0.1:${address.port}/`;
    };
    let url: string;
    if (kind === 'webpack') {
      await writeFile(join(canonicalConsumerRoot, 'build.mjs'), webpackBuildSource);
      await runFile(process.execPath, ['build.mjs'], { cwd: canonicalConsumerRoot, maxBuffer: 10 * 1024 * 1024 });
      await writeFile(
        join(canonicalConsumerRoot, 'dist/index.html'),
        consumerDocument('<script type="module" src="/main.js"></script>')
      );
      url = await serveBuilt(runtimeHeaders);
    } else {
      await writeFile(
        join(canonicalConsumerRoot, 'index.html'),
        consumerDocument('<script type="module" src="/src/main.js"></script>')
      );
      await writeFile(
        join(canonicalConsumerRoot, 'vite.config.js'),
        "import { mimic } from '@mimic-js/runtime/vite';\n\nexport default { plugins: [mimic()] };\n"
      );
      const vite = join(canonicalConsumerRoot, 'node_modules/vite/bin/vite.js');
      if (kind === 'vite-preview') {
        await runFile(process.execPath, [vite, 'build'], { cwd: canonicalConsumerRoot, maxBuffer: 10 * 1024 * 1024 });
      }
      const port = await freePort();
      const output: string[] = [];
      bundlerServer = spawn(
        process.execPath,
        [vite, ...(kind === 'vite-preview' ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        { cwd: canonicalConsumerRoot, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      bundlerServer.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      bundlerServer.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      url = `http://127.0.0.1:${port}/`;
      await waitForServer(url, bundlerServer, () => output.join(''));
    }

    return Object.freeze({
      url,
      consumerRoot: canonicalConsumerRoot,
      packedArtifact: await realpath(packedArtifact),
      close,
      serveWithout(headers: 'cross-origin-isolation') {
        if (kind !== 'webpack') throw new Error(`The ${kind} consumer is served by its bundler.`);
        if (headers !== 'cross-origin-isolation') throw new Error(`Unknown header set ${String(headers)}.`);
        return serveBuilt(withoutHeaders(['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy']));
      }
    });
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Bundled consumer setup and cleanup both failed.');
    }
    throw error;
  }
}

/** What a consumer's own server must send; see the package README. */
const runtimeHeaders: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
};

function withoutHeaders(names: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(runtimeHeaders).filter(([name]) => !names.includes(name)));
}

const webpackBuildSource = `import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const compiler = webpack({
  mode: 'production',
  entry: './src/main.js',
  output: {
    path: fileURLToPath(new URL('./dist/', import.meta.url)),
    publicPath: '/',
    filename: 'main.js',
    // The Service Worker lands in a directory of its own, as it does in most
    // builds; its scope is the endpoints directory beside it, so no header is needed.
    assetModuleFilename: 'assets/[hash][ext]',
    module: true
  },
  experiments: { outputModule: true },
  performance: { hints: false }
});
compiler.run((error, stats) => {
  if (error || stats.hasErrors()) {
    console.error(error ?? stats.toString({ colors: false }));
    process.exitCode = 1;
  }
  compiler.close(() => undefined);
});
`;

function startStaticServer(root: string, headers: Readonly<Record<string, string>>): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      response.setHeader('Cache-Control', 'no-store');
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://consumer.invalid').pathname);
      const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
      if (!isWithin(root, path)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      try {
        const contents = await readFile(path);
        response.setHeader('Content-Type', contentType(path));
        response.end(contents);
      } catch (error: unknown) {
        response.statusCode = isMissing(error) ? 404 : 500;
        response.end();
      }
    })();
  });
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveServer(server);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address !== 'string') resolvePort(address.port);
        else reject(new Error('Could not reserve a TCP port for the bundled consumer.'));
      });
    });
  });
}

async function waitForServer(url: string, server: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The bundled consumer's server exited with ${server.exitCode}:\n${output()}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The bundled consumer's server did not answer ${url}:\n${output()}`);
}
