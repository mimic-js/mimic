import { moduleFormatFromPath } from '../module-format';
import type {
  CompiledRuntimeArtifact,
  RuntimeArtifactCompile,
  RuntimeArtifactKind
} from './artifacts';
import { contentHash } from './content-hash';

/**
 * One request to the compile service. A context first asks by hash alone; only
 * when the service has no entry does it send the source.
 */
export interface RuntimeArtifactCompileRequest {
  readonly kind: RuntimeArtifactKind;
  readonly hash: string;
  readonly source?: string;
}

export interface RuntimeArtifactCompileFailure {
  readonly name: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type RuntimeArtifactTranslation =
  | ({ readonly status: 'compiled' } & CompiledRuntimeArtifact)
  | { readonly status: 'failed'; readonly error: RuntimeArtifactCompileFailure };

export type RuntimeArtifactCompileResponse =
  | RuntimeArtifactTranslation
  | { readonly status: 'miss' };

/**
 * Compiled text that outlives the epoch, keyed by kind and content hash within
 * one compiler version. Every method may fail silently: it is a cache.
 */
export interface CompiledArtifactStore {
  read(key: string): Promise<string | undefined>;
  has(key: string): Promise<boolean>;
  write(key: string, text: string): Promise<void>;
}

/** Whether a translation was asked for by a waiting context or ahead of its first use. */
export type RuntimeArtifactTranslationPriority = 'demand' | 'ahead';

export interface RuntimeArtifactCompileServiceOptions {
  /** Compiles off the calling context, in the compiler pool. */
  translate(
    kind: RuntimeArtifactKind,
    source: string,
    priority: RuntimeArtifactTranslationPriority
  ): Promise<RuntimeArtifactTranslation>;
  readonly store?: CompiledArtifactStore;
  /** The bound of compiled text kept in memory, in UTF-16 code units. */
  readonly memoryCharacters?: number;
}

/** The files ahead-of-time compilation reads. */
export interface PrecompileFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<Array<string | PrecompileDirent>>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

type PrecompileDirent = Readonly<{
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}>;

export interface PrecompileSummary {
  readonly compiled: number;
  readonly cached: number;
  readonly failed: number;
}

export interface RuntimeArtifactCompileService {
  /**
   * Answers one {@link RuntimeArtifactCompileRequest} from a context. A request
   * that carries a source whose content hash is not `hash` is rejected with a
   * {@link CompileCacheKeyMismatchError}: nothing is compiled, stored or served
   * under a key the context chose.
   */
  serve(request: RuntimeArtifactCompileRequest): Promise<RuntimeArtifactCompileResponse>;
  /** Compiles the JavaScript installed under `root/node_modules` ahead of its first use. */
  precompile(root: string, files: PrecompileFileSystem): Promise<PrecompileSummary>;
  dispose(): void;
}

/**
 * A context sent a source under a key that is not its content hash. The cache
 * is shared by every context, epoch and tab of the origin, so an entry is only
 * ever written under the key the Runtime Host derives from the source itself.
 */
export class CompileCacheKeyMismatchError extends Error {
  override readonly name = 'CompileCacheKeyMismatchError';

  constructor(
    readonly kind: RuntimeArtifactKind,
    readonly requested: string,
    readonly actual: string
  ) {
    super(
      `The compile cache key ${kind}-${requested} is not the content hash of the source sent with it (${actual}).`
    );
  }
}

const DEFAULT_MEMORY_CHARACTERS = 64 * 1024 * 1024;
/** Larger files are compiled when a context first loads them, not ahead. */
const MAX_PRECOMPILE_CHARACTERS = 4 * 1024 * 1024;
const PRECOMPILE_EXTENSIONS = /\.(?:c|m)?js$/;

/**
 * The compile cache of one Runtime Host epoch. Every context of the epoch asks
 * it, so each distinct source is compiled once per machine: entries are kept
 * as text in memory, persisted through the store, and compiled in the pool
 * when neither has them. Requests for one key share one compilation.
 */
export function createRuntimeArtifactCompileService(
  options: RuntimeArtifactCompileServiceOptions
): RuntimeArtifactCompileService {
  const memory = new TextLru(options.memoryCharacters ?? DEFAULT_MEMORY_CHARACTERS);
  const inFlight = new Map<string, Promise<RuntimeArtifactTranslation>>();
  let disposed = false;

  const lookup = async (key: string, persisted: boolean): Promise<CompiledRuntimeArtifact | undefined> => {
    const cached = memory.get(key);
    if (cached !== undefined) return decodeEntry(cached);
    if (!persisted) return undefined;
    const stored = await options.store?.read(key).catch(() => undefined);
    if (stored === undefined) return undefined;
    const compiled = decodeEntry(stored);
    if (!compiled) return undefined;
    memory.set(key, stored);
    return compiled;
  };

  const compile = (
    kind: RuntimeArtifactKind,
    hash: string,
    source: string,
    priority: RuntimeArtifactTranslationPriority
  ): Promise<RuntimeArtifactTranslation> => {
    const key = entryKey(kind, hash);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const translation = options.translate(kind, source, priority).then((result) => {
      if (result.status === 'compiled' && !disposed) {
        const text = encodeEntry(result);
        // A detected source is also the artifact of the format it was detected as.
        const keys = new Set([key, entryKey(concreteKind(kind, result.format), hash)]);
        for (const entry of keys) {
          memory.set(entry, text);
          void options.store?.write(entry, text).catch(() => undefined);
        }
      }
      return result;
    });
    inFlight.set(key, translation);
    const settle = () => inFlight.delete(key);
    void translation.then(settle, settle);
    return translation;
  };

  return {
    async serve(request) {
      // The key is the Runtime Host's to derive: a context's claim is verified
      // against the source before the source is compiled or anything is stored.
      if (request.source !== undefined) {
        const actual = contentHash(request.source);
        if (actual !== request.hash) throw new CompileCacheKeyMismatchError(request.kind, request.hash, actual);
      }
      const key = entryKey(request.kind, request.hash);
      const compiled = await lookup(key, request.source === undefined);
      if (compiled) return { status: 'compiled', ...compiled };
      const pending = inFlight.get(key);
      if (pending) return pending;
      if (request.source === undefined) return { status: 'miss' };
      return compile(request.kind, request.hash, request.source, 'demand');
    },

    async precompile(root, files) {
      let compiled = 0;
      let cached = 0;
      let failed = 0;
      const visit = async (directory: string, packageType: unknown): Promise<void> => {
        if (disposed) return;
        let entries: Array<string | PrecompileDirent>;
        try {
          entries = await files.readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        const dirents = entries.filter((entry): entry is PrecompileDirent => typeof entry !== 'string');
        // The nearest package.json decides `type` for everything below it.
        if (dirents.some((entry) => entry.name === 'package.json' && entry.isFile())) {
          packageType = await files
            .readFile(`${directory}/package.json`, 'utf8')
            .then((text) => (JSON.parse(text) as { type?: unknown }).type)
            .catch(() => undefined);
        }
        for (const entry of dirents) {
          if (disposed) return;
          const path = `${directory}/${entry.name}`;
          // Symbolic links lead to directories the walk reaches by their own
          // path (pnpm's store, workspace packages) or out of the tree.
          if (entry.isDirectory()) {
            if (entry.name !== '.bin' && entry.name !== '.cache') await visit(path, packageType);
            continue;
          }
          if (!entry.isFile() || !PRECOMPILE_EXTENSIONS.test(entry.name) || entry.name.endsWith('.min.js')) continue;
          const kind = moduleFormatFromPath(path, packageType);
          if (kind !== 'commonjs' && kind !== 'module' && kind !== 'detect') continue;
          const source = await files.readFile(path, 'utf8').catch(() => undefined);
          if (source === undefined || source.length > MAX_PRECOMPILE_CHARACTERS) continue;
          const hash = contentHash(source);
          const key = entryKey(kind, hash);
          if (memory.has(key) || inFlight.has(key) || (await options.store?.has(key).catch(() => false))) {
            cached += 1;
            continue;
          }
          const result = await compile(kind, hash, source, 'ahead');
          if (result.status === 'compiled') compiled += 1;
          else failed += 1;
        }
      };
      await visit(`${root === '/' ? '' : root}/node_modules`, undefined);
      return { compiled, cached, failed };
    },

    dispose() {
      disposed = true;
      memory.clear();
    }
  };
}

/**
 * The context side of the compile service: a synchronous
 * {@link RuntimeArtifactCompile} over a blocking call to the Runtime Host.
 */
export function createRuntimeArtifactCompileClient(
  call: (request: RuntimeArtifactCompileRequest) => RuntimeArtifactCompileResponse
): RuntimeArtifactCompile {
  return (kind, source) => {
    const hash = contentHash(source);
    let response = call({ kind, hash });
    if (response.status === 'miss') response = call({ kind, hash, source });
    if (response.status === 'compiled') return { format: response.format, code: response.code };
    if (response.status === 'failed') throw compileFailureError(response.error);
    throw new Error('The compile service answered a request that carried its source with a miss.');
  };
}

/** Serializes what a translation threw: the compiler's error and its location. */
export function runtimeArtifactCompileFailure(error: unknown): RuntimeArtifactCompileFailure {
  const failure = error instanceof Error ? error : new Error(String(error));
  const loc = (failure as Error & { readonly loc?: { readonly line?: unknown; readonly column?: unknown } }).loc;
  return {
    name: failure.name,
    message: failure.message,
    ...(typeof loc?.line === 'number' && typeof loc.column === 'number'
      ? { line: loc.line, column: loc.column }
      : {})
  };
}

function compileFailureError(failure: RuntimeArtifactCompileFailure): Error {
  const error = failure.name === 'TypeError' ? new TypeError(failure.message) : new SyntaxError(failure.message);
  if (failure.line !== undefined && failure.column !== undefined) {
    Object.assign(error, { loc: { line: failure.line, column: failure.column } });
  }
  return error;
}

function entryKey(kind: RuntimeArtifactKind, hash: string): string {
  return `${kind}-${hash}`;
}

function concreteKind(kind: RuntimeArtifactKind, format: CompiledRuntimeArtifact['format']): RuntimeArtifactKind {
  // An eval source is instrumented text, not a module's function text.
  if (kind === 'eval') return kind;
  const typeScript = kind.endsWith('-typescript');
  if (format === 'module') return typeScript ? 'module-typescript' : 'module';
  return typeScript ? 'commonjs-typescript' : 'commonjs';
}

/** An entry is its format on the first line and the compiled text after it. */
function encodeEntry(compiled: CompiledRuntimeArtifact): string {
  return `${compiled.format}\n${compiled.code}`;
}

function decodeEntry(text: string): CompiledRuntimeArtifact | undefined {
  const newline = text.indexOf('\n');
  const format = text.slice(0, newline);
  if (format !== 'commonjs' && format !== 'module') return undefined;
  return { format, code: text.slice(newline + 1) };
}

/** Least recently used text, bounded by total length. */
class TextLru {
  private readonly entries = new Map<string, string>();
  private characters = 0;

  constructor(private readonly limit: number) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): string | undefined {
    const text = this.entries.get(key);
    if (text === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, text);
    return text;
  }

  set(key: string, text: string): void {
    this.delete(key);
    if (text.length > this.limit / 4) return;
    this.entries.set(key, text);
    this.characters += text.length;
    for (const [oldest, oldestText] of this.entries) {
      if (this.characters <= this.limit) break;
      this.entries.delete(oldest);
      this.characters -= oldestText.length;
    }
  }

  clear(): void {
    this.entries.clear();
    this.characters = 0;
  }

  private delete(key: string): void {
    const text = this.entries.get(key);
    if (text === undefined) return;
    this.entries.delete(key);
    this.characters -= text.length;
  }
}
