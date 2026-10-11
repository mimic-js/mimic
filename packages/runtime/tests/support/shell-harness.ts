import {
  createCoreUtilities,
  type CoreUtilityFileStatus,
  type CoreUtilityFileSystem
} from '../../src/runtime/modules/process-execution/core-utilities';
import {
  createShellProgram,
  type ShellChild,
  type ShellChildSpawnRequest,
  type ShellProgramServices
} from '../../src/runtime/modules/process-execution/shell-program';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export type TestCommand = (
  request: ShellChildSpawnRequest,
  io: { readonly stdin: string; out(text: string): void; err(text: string): void }
) => number | Promise<number>;

/** An in-memory filesystem: `null` marks a directory. */
export function createMemoryFileSystem(initial: Readonly<Record<string, string | null>> = {}): {
  readonly entries: Map<string, Uint8Array | null>;
  readonly fileSystem: CoreUtilityFileSystem;
  text(path: string): string | undefined;
} {
  const entries = new Map<string, Uint8Array | null>([['/', null]]);
  const mtimes = new Map<string, number>();
  const addDirectories = (path: string): void => {
    for (let directory = posixDirname(path); !entries.has(directory); directory = posixDirname(directory)) {
      entries.set(directory, null);
    }
  };
  for (const [path, contents] of Object.entries(initial)) {
    addDirectories(path);
    entries.set(path, contents === null ? null : encoder.encode(contents));
  }
  const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const children = (path: string): string[] => {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...entries.keys()].filter(
      (candidate) => candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/')
    );
  };
  const fileSystem: CoreUtilityFileSystem = {
    stat(path): CoreUtilityFileStatus | undefined {
      const entry = entries.get(path);
      if (entry === undefined) return undefined;
      return {
        kind: entry === null ? 'directory' : 'file',
        size: entry?.byteLength ?? 0,
        mtimeMs: mtimes.get(path) ?? 0,
        mode: entry === null ? 0o755 : 0o644
      };
    },
    readFile(path) {
      const entry = entries.get(path);
      if (!entry) throw missing(path);
      return entry;
    },
    writeFile(path, data) {
      if (entries.get(posixDirname(path)) !== null) throw missing(path);
      entries.set(path, data);
    },
    readDirectory(path) {
      if (entries.get(path) !== null) throw missing(path);
      return children(path).map((child) => child.slice(child.lastIndexOf('/') + 1));
    },
    makeDirectory(path, { recursive }) {
      if (recursive) addDirectories(`${path}/child`);
      else if (entries.get(posixDirname(path)) !== null) throw missing(path);
      entries.set(path, null);
    },
    remove(path, { recursive }) {
      if (!entries.has(path)) throw missing(path);
      if (recursive) {
        for (const candidate of [...entries.keys()]) {
          if (candidate.startsWith(`${path}/`)) entries.delete(candidate);
        }
      }
      entries.delete(path);
    },
    rename(from, to) {
      for (const candidate of [...entries.keys()]) {
        if (candidate !== from && !candidate.startsWith(`${from}/`)) continue;
        entries.set(`${to}${candidate.slice(from.length)}`, entries.get(candidate)!);
        entries.delete(candidate);
      }
    },
    setModifiedTime(path, mtimeMs) {
      mtimes.set(path, mtimeMs);
    },
    readLink(path) {
      throw missing(path);
    },
    symlink(_target, path) {
      throw missing(path);
    }
  };
  return {
    entries,
    fileSystem,
    text: (path) => {
      const entry = entries.get(path);
      return entry ? decoder.decode(entry) : undefined;
    }
  };
}

export type ShellRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly ShellChildSpawnRequest[];
};

export function createShellHarness(
  options: {
    readonly files?: Readonly<Record<string, string | null>>;
    readonly commands?: Readonly<Record<string, TestCommand>>;
    readonly replace?: ShellProgramServices['replace'];
  } = {}
): {
  readonly memory: ReturnType<typeof createMemoryFileSystem>;
  readonly services: ShellProgramServices;
  run(
    argv: readonly string[],
    invocation?: { readonly env?: Record<string, string>; readonly stdin?: string; readonly cwd?: string }
  ): Promise<ShellRun>;
} {
  const memory = createMemoryFileSystem({ '/home/project': null, ...options.files });
  const utilities = new Map(
    createCoreUtilities(() => [['node', '/usr/bin/node']]).flatMap((utility) =>
      utility.commands.map((command) => [command, utility] as const)
    )
  );
  const calls: ShellChildSpawnRequest[] = [];
  let nextPid = 100;
  const program = createShellProgram();

  const start = (
    request: ShellChildSpawnRequest,
    body: (io: { stdin: ReadableStream<Uint8Array>; out(text: string | Uint8Array): void; err(text: string): void }) => Promise<number>
  ): ShellChild => {
    const stdout = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, { highWaterMark: 1024 });
    const stderr = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, { highWaterMark: 1024 });
    const out = stdout.writable.getWriter();
    const err = stderr.writable.getWriter();
    const exit = (async () => {
      try {
        return await body({
          stdin: request.stdin,
          out: (text) => void out.write(typeof text === 'string' ? encoder.encode(text) : text).catch(() => undefined),
          err: (text) => void err.write(encoder.encode(text)).catch(() => undefined)
        });
      } finally {
        await Promise.all([out.close().catch(() => undefined), err.close().catch(() => undefined)]);
      }
    })();
    return {
      pid: (nextPid += 1),
      stdin: new WritableStream<Uint8Array>(),
      stdout: stdout.readable,
      stderr: stderr.readable,
      exit,
      kill() {}
    };
  };

  const services: ShellProgramServices = {
    children: {
      async spawn(request) {
        calls.push(request);
        const custom = options.commands?.[request.command];
        if (custom) {
          return start(request, async (io) =>
            custom(request, { stdin: await readAll(io.stdin), out: io.out, err: io.err })
          );
        }
        if (request.command === 'sh') {
          // A subshell is a child Shell Program, as it is under Process Execution.
          return start(request, (io) => {
            const reader = io.stdin.getReader();
            return program.run(
              {
                argv: request.args,
                cwd: request.cwd,
                env: request.env,
                pid: nextPid,
                parentPid: request.parentPid,
                stdin: { read: async () => (await reader.read()).value },
                stdout: { ...writer([]), write: (chunk) => io.out(chunk) },
                stderr: {
                  ...writer([]),
                  write: (chunk) => io.err(typeof chunk === 'string' ? chunk : decoder.decode(chunk))
                },
                signal: new Promise<never>(() => undefined)
              },
              services
            );
          });
        }
        const utility = utilities.get(request.command);
        if (!utility) {
          throw Object.assign(new Error(`Executable program was not found: ${request.command}`), {
            code: 'EXECUTABLE_NOT_FOUND'
          });
        }
        return start(request, (io) => {
          const reader = io.stdin.getReader();
          return utility.run(request.args, {
            cwd: request.cwd,
            env: request.env,
            stdin: { read: async () => (await reader.read()).value },
            stdout: { write: (chunk) => io.out(chunk) },
            stderr: { write: (chunk) => io.err(typeof chunk === 'string' ? chunk : decoder.decode(chunk)) },
            fileSystem: memory.fileSystem
          });
        });
      }
    },
    ...(options.replace ? { replace: options.replace } : {}),
    files: memory.fileSystem
  };

  return {
    memory,
    services,
    async run(argv, invocation = {}) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      calls.length = 0;
      let pending = invocation.stdin === undefined ? undefined : encoder.encode(invocation.stdin);
      const code = await program.run(
        {
          argv,
          cwd: invocation.cwd ?? '/home/project',
          env: { PATH: '/usr/bin', HOME: '/home', ...invocation.env },
          pid: 41,
          parentPid: 0,
          stdin: {
            read: async () => {
              const chunk = pending;
              pending = undefined;
              return chunk;
            }
          },
          stdout: writer(stdout),
          stderr: writer(stderr),
          signal: new Promise<never>(() => undefined)
        },
        services
      );
      return { code, stdout: stdout.join(''), stderr: stderr.join(''), calls: [...calls] };
    }
  };
}

function writer(chunks: string[]) {
  return {
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk));
    },
    close() {},
    fail(error: unknown) {
      throw error;
    },
    waitForKill: () => new Promise<never>(() => undefined)
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}
