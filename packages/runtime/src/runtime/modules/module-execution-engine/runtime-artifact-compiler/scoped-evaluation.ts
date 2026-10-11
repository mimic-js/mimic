/**
 * Evaluation of source whose free identifiers resolve against objects, the
 * primitive `node:vm` contexts are built on. Each object is a `with` scope
 * around the evaluated code, outermost first, so a proxy decides which names
 * it owns. The code runs in this realm and shares its intrinsics.
 */

/** The wrapper's own names, which an evaluated program's identifiers never resolve to. */
export const SCOPED_EVALUATION_PREFIX = '__mimicVm';

const globalEval = globalThis.eval;

export type ScopedScriptOptions = Readonly<{
  filename: string;
  /** `with` scopes, outermost first. */
  scopes: readonly object[];
  /** `this` at the top level of the script. */
  thisValue: unknown;
  /**
   * Names the script declares with `var` or `function` at its top level. They
   * stay in the script's own scope while it runs, and their values are returned.
   */
  declared: readonly string[];
}>;

/** Runs `source` as a sloppy-mode script; answers its completion value and the values of `declared`. */
export function evaluateInScopes(
  source: string,
  options: ScopedScriptOptions
): { readonly result: unknown; readonly declared: readonly unknown[] } {
  const scopes = `${SCOPED_EVALUATION_PREFIX}Scopes`;
  const script = `${SCOPED_EVALUATION_PREFIX}Source`;
  const names = options.declared.join(', ');
  const run = globalEval(
    `(function (${scopes}, ${script}) {` +
      (names ? `var ${names};` : '') +
      withScopes(options.scopes.length, scopes, `return [eval(${script}), [${names}]];`) +
      `})\n//# sourceURL=${options.filename}`
  ) as (this: unknown, scopes: readonly object[], source: string) => [unknown, unknown[]];
  const [result, declared] = run.call(options.thisValue, options.scopes, source);
  return { result, declared };
}

/** A function of `params` whose body is `body`, its free identifiers resolved through `scopes`. */
export function compileFunctionInScopes(
  body: string,
  params: readonly string[],
  options: Readonly<{ filename: string; scopes: readonly object[] }>
): Function {
  const scopes = `${SCOPED_EVALUATION_PREFIX}Scopes`;
  const factory = globalEval(
    `(function (${scopes}) {` +
      withScopes(options.scopes.length, scopes, `return function (${params.join(', ')}) {${body}\n};`) +
      `})\n//# sourceURL=${options.filename}`
  ) as (scopes: readonly object[]) => Function;
  return factory(options.scopes);
}

function withScopes(count: number, scopes: string, body: string): string {
  let text = body;
  for (let index = count - 1; index >= 0; index -= 1) text = `with (${scopes}[${index}]) {${text}}`;
  return text;
}
