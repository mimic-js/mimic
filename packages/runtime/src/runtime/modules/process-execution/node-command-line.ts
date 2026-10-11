/**
 * The `node` command line as the node Runtime Program and inline-entry
 * resolution both read it: one option table decides which arguments are
 * options, which take a value, and where the entry begins.
 */

export type NodeCommandLineAction =
  | { readonly kind: 'run'; readonly entry: string }
  | { readonly kind: 'eval'; readonly source: string; readonly print: boolean }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }
  | { readonly kind: 'none' };

export interface NodeCommandLine {
  readonly action: NodeCommandLineAction;
  /** Every option as typed, which is what `process.execArgv` reports. */
  readonly execArgv: readonly string[];
  /** `execArgv` without the inline source, for re-running a projected inline entry. */
  readonly optionArgv: readonly string[];
  readonly applicationArgs: readonly string[];
  readonly preloads: {
    readonly require: readonly string[];
    readonly import: readonly string[];
  };
  readonly conditions: readonly string[];
  readonly inputType?: 'module' | 'commonjs';
  readonly envFiles: readonly { readonly path: string; readonly required: boolean }[];
  /** Boolean options in effect, by name; `--no-x` and `--x` replace each other. */
  readonly flags: ReadonlySet<string>;
  /** Last value given for each value option, by canonical name. */
  readonly values: ReadonlyMap<string, string>;
}

export type NodeCommandLineResult =
  | { readonly ok: true; readonly value: NodeCommandLine }
  | {
      readonly ok: false;
      readonly message: string;
      readonly exitCode: 9;
      /** Set when the inline source itself is what the command line left out. */
      readonly missingInlineSource?: true;
    };

type NodeOptionKind = 'boolean' | 'value' | 'unsupported';

/** Options that take a value, either as `--option=value` or as the next argument. */
const VALUE_OPTIONS = [
  '--require',
  '--import',
  '--conditions',
  '--eval',
  '--input-type',
  '--env-file',
  '--env-file-if-exists',
  '--loader',
  '--experimental-loader',
  '--experimental-default-type',
  '--title',
  '--unhandled-rejections',
  '--stack-trace-limit',
  '--max-http-header-size',
  '--dns-result-order',
  '--diagnostic-dir',
  '--disable-warning',
  '--redirect-warnings',
  '--trace-event-categories',
  '--trace-event-file-pattern',
  '--watch-path',
  '--inspect-port',
  '--debug-port',
  '--icu-data-dir',
  '--openssl-config',
  '--secure-heap',
  '--secure-heap-min',
  '--heapsnapshot-signal',
  '--heapsnapshot-near-heap-limit',
  '--heap-prof-dir',
  '--heap-prof-name',
  '--heap-prof-interval',
  '--cpu-prof-dir',
  '--cpu-prof-name',
  '--cpu-prof-interval',
  '--report-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--tls-cipher-list',
  '--tls-keylog',
  '--localstorage-file',
  '--v8-pool-size',
  '--use-largepages',
  '--max-old-space-size',
  '--max-semi-space-size',
  '--min-semi-space-size',
  '--semi-space-growth-factor',
  '--max-heap-size',
  '--initial-heap-size',
  '--initial-old-space-size',
  '--stack-size',
  '--gc-interval',
  '--random-seed',
  '--max-lazy'
] as const;

/** Options without a value. Each also has a `--no-` form. */
const BOOLEAN_OPTIONS = [
  '--enable-source-maps',
  '--warnings',
  '--deprecation',
  '--trace-warnings',
  '--trace-deprecation',
  '--throw-deprecation',
  '--pending-deprecation',
  '--preserve-symlinks',
  '--preserve-symlinks-main',
  '--expose-gc',
  '--expose-internals',
  '--abort-on-uncaught-exception',
  '--watch',
  '--watch-preserve-output',
  '--frozen-intrinsics',
  '--disallow-code-generation-from-strings',
  '--force-context-aware',
  '--force-node-api-uncaught-exceptions-policy',
  '--insecure-http-parser',
  '--jitless',
  '--node-memory-debug',
  '--use-openssl-ca',
  '--use-bundled-ca',
  '--verify-base-objects',
  '--zero-fill-buffers',
  '--track-heap-objects',
  '--prof',
  '--prof-process',
  '--cpu-prof',
  '--heap-prof',
  '--interpreted-frames-native-stack',
  '--huge-max-old-generation-size',
  '--enable-fips',
  '--force-fips',
  '--network-family-autoselection',
  '--global-search-paths',
  '--addons',
  '--extra-info-on-fatal-exception',
  '--async-context-frame',
  '--node-snapshot',
  '--entry-url',
  '--optimize-for-size',
  '--opt',
  '--single-threaded',
  '--allow-natives-syntax',
  '--always-compact',
  '--force-async-hooks-checks',
  '--wasm-lazy-compilation',
  '--concurrent-recompilation',
  '--lazy'
] as const;

/** Families of boolean options, which may also carry a value after `=`. */
const BOOLEAN_OPTION_PREFIXES = [
  '--experimental-',
  '--harmony',
  '--trace-',
  '--inspect',
  '--perf-',
  '--report-',
  '--tls-',
  '--wasm-',
  '--turbo-',
  '--max-inlined-'
] as const;

/** Options Node has that change what `node` does in a way this runtime does not provide. */
const UNSUPPORTED_OPTIONS = [
  '--check',
  '--interactive',
  '--test',
  '--test-only',
  '--run',
  '--build-snapshot',
  '--experimental-sea-config',
  '--v8-options',
  '--completion-bash'
] as const;

const SHORT_OPTION_ALIASES: Readonly<Record<string, string>> = {
  '-r': '--require',
  '-C': '--conditions',
  '-e': '--eval',
  '-p': '--print',
  '-v': '--version',
  '-h': '--help',
  '-c': '--check',
  '-i': '--interactive'
};

const OPTION_KINDS = new Map<string, NodeOptionKind>([
  ...BOOLEAN_OPTIONS.map((name) => [name, 'boolean'] as const),
  ...UNSUPPORTED_OPTIONS.map((name) => [name, 'unsupported'] as const),
  // A name listed as both resolves to the value form.
  ...VALUE_OPTIONS.map((name) => [name, 'value'] as const)
]);

function optionKind(name: string): NodeOptionKind | undefined {
  const exact = OPTION_KINDS.get(name);
  if (exact) return exact;
  if (BOOLEAN_OPTION_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'boolean';
  return undefined;
}

function badOption(argument: string): NodeCommandLineResult {
  return { ok: false, message: `node: bad option: ${argument}`, exitCode: 9 };
}

function missingArgument(option: string, missingInlineSource = false): NodeCommandLineResult {
  return {
    ok: false,
    message: `node: ${option} requires an argument`,
    exitCode: 9,
    ...(missingInlineSource ? { missingInlineSource: true as const } : {})
  };
}

export function parseNodeCommandLine(args: readonly string[]): NodeCommandLineResult {
  const execArgv: string[] = [];
  const optionArgv: string[] = [];
  const requirePreloads: string[] = [];
  const importPreloads: string[] = [];
  const conditions: string[] = [];
  const envFiles: { path: string; required: boolean }[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let inputType: 'module' | 'commonjs' | undefined;
  let evalSource: string | undefined;
  let print = false;
  let immediate: 'version' | 'help' | undefined;
  let entry: string | undefined;
  let applicationArgs: readonly string[] = [];

  let index = 0;
  while (index < args.length) {
    const argument = args[index]!;
    if (argument === '--') {
      // Everything after the terminator is positional, even when it looks like an option.
      const rest = args.slice(index + 1);
      if (evalSource === undefined && !immediate) {
        entry = rest[0];
        applicationArgs = rest.slice(1);
      } else {
        applicationArgs = rest;
      }
      break;
    }
    if (argument === '-' || !argument.startsWith('-')) {
      if (evalSource === undefined && !immediate) {
        entry = argument;
        applicationArgs = args.slice(index + 1);
      } else {
        applicationArgs = args.slice(index);
      }
      break;
    }

    if (argument === '-pe') {
      const source = args[index + 1];
      if (source === undefined) return missingArgument(argument, true);
      print = true;
      evalSource = source;
      execArgv.push(argument, source);
      index += 2;
      continue;
    }

    const separator = argument.indexOf('=');
    const typedName = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
    const name = argument.startsWith('--')
      ? typedName.replaceAll('_', '-')
      : SHORT_OPTION_ALIASES[typedName];
    if (!name) return badOption(argument);

    if (name === '--version' || name === '--help') {
      if (inlineValue !== undefined) return badOption(argument);
      immediate ??= name === '--version' ? 'version' : 'help';
      execArgv.push(argument);
      index += 1;
      continue;
    }

    if (name === '--print') {
      const next = args[index + 1];
      const source = inlineValue ?? (next !== undefined && !next.startsWith('-') ? next : undefined);
      print = true;
      if (source === undefined) {
        // `-p -e source` names the source through the option that follows.
        execArgv.push(argument);
        index += 1;
        continue;
      }
      evalSource = source;
      if (inlineValue === undefined) {
        execArgv.push(argument, source);
        index += 2;
      } else {
        execArgv.push(argument);
        index += 1;
      }
      continue;
    }

    const negated = name.startsWith('--no-');
    const kind = optionKind(negated ? `--${name.slice('--no-'.length)}` : name);
    if (!kind || (negated && kind !== 'boolean')) return badOption(argument);
    if (kind === 'unsupported') {
      return {
        ok: false,
        message: `node: ${typedName} is not supported in Mimic`,
        exitCode: 9
      };
    }

    if (kind === 'boolean') {
      flags.delete(negated ? `--${name.slice('--no-'.length)}` : `--no-${name.slice(2)}`);
      flags.add(name);
      if (inlineValue !== undefined) values.set(name, inlineValue);
      execArgv.push(argument);
      optionArgv.push(argument);
      index += 1;
      continue;
    }

    let value = inlineValue;
    const tokens = [argument];
    if (value === undefined) {
      value = args[index + 1];
      if (value === undefined) return missingArgument(typedName, name === '--eval');
      tokens.push(value);
    }
    if (value === '') return missingArgument(typedName, name === '--eval');
    index += tokens.length;
    execArgv.push(...tokens);

    if (name === '--eval') {
      evalSource = value;
      continue;
    }
    optionArgv.push(...tokens);
    values.set(name, value);
    if (name === '--require') requirePreloads.push(value);
    else if (name === '--import') importPreloads.push(value);
    else if (name === '--conditions') conditions.push(value);
    else if (name === '--env-file') envFiles.push({ path: value, required: true });
    else if (name === '--env-file-if-exists') envFiles.push({ path: value, required: false });
    else if (name === '--input-type') {
      if (value !== 'module' && value !== 'commonjs') {
        return {
          ok: false,
          message: 'node: --input-type must be "module" or "commonjs"',
          exitCode: 9
        };
      }
      inputType = value;
    }
  }

  if (print && evalSource === undefined && !immediate) return missingArgument('-p', true);
  if (print && inputType === 'module') {
    return { ok: false, message: 'node: --print cannot be used with ESM input', exitCode: 9 };
  }

  const action: NodeCommandLineAction = immediate
    ? { kind: immediate }
    : evalSource !== undefined
      ? { kind: 'eval', source: evalSource, print }
      : entry !== undefined
        ? { kind: 'run', entry }
        : { kind: 'none' };

  return {
    ok: true,
    value: Object.freeze({
      action: Object.freeze(action),
      execArgv: Object.freeze(execArgv),
      optionArgv: Object.freeze(optionArgv),
      applicationArgs: Object.freeze([...applicationArgs]),
      preloads: Object.freeze({
        require: Object.freeze(requirePreloads),
        import: Object.freeze(importPreloads)
      }),
      conditions: Object.freeze(conditions),
      ...(inputType ? { inputType } : {}),
      envFiles: Object.freeze(envFiles),
      flags,
      values
    })
  };
}
