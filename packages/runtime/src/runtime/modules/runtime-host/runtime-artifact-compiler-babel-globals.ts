/**
 * Babel's packages read a few members of Node's `process` when they load and
 * when they run: the environment, the working directory for configuration it
 * never loads here, and the version. The compiler worker has no `process`, so
 * this provides the members `@babel/standalone` provides for the same reason.
 * Imported before any Babel package, for its effect.
 */
type BabelHostProcess = {
  readonly env: Record<string, string | undefined>;
  cwd(): string;
  readonly versions: Readonly<Record<string, string>>;
  emitWarning(warning: unknown): void;
};

const host = globalThis as { process?: BabelHostProcess };

host.process ??= {
  env: {},
  cwd: () => '/',
  versions: {},
  emitWarning: () => {}
};
