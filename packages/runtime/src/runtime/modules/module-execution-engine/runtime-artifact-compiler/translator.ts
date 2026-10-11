import {
  JSON_IMPORT_PREFIX,
  runtimeArtifactFunctionText,
  type CompiledRuntimeArtifact,
  type RuntimeArtifactCompile
} from './artifacts';

/** The part of Babel the translator uses; the caller loads it (ADR-0034). */
export interface BabelStandalone {
  readonly version: string;
  readonly packages: Readonly<{
    parser: Readonly<{ parse(source: string, options: Record<string, unknown>): unknown }>;
  }>;
  transform(
    code: string,
    options: Record<string, unknown>
  ): { readonly code?: string | null };
}

/**
 * Increased whenever the translator's output changes for the same input. The
 * compile cache keys entries by it and by the Babel version, so an artifact
 * persisted by an older build is never evaluated by a newer one.
 */
export const RUNTIME_ARTIFACT_TRANSLATOR_REVISION = 7;

type Format = CompiledRuntimeArtifact['format'];

/**
 * Translates source text into the text of one function expression that a
 * context evaluates once per module. The text depends only on the kind and the
 * source, never on where the source was read from, so one cached translation
 * serves every copy of a file.
 *
 * Both formats share one instrumentation, a source-to-source rewrite: every
 * top-level expression statement reports its value to `__trackAsync`, every
 * `import()` calls `__import__`, and every `await` and `for await` operand
 * passes through the Async Context (ADR-0018). A CommonJS script is then
 * evaluated as written, so its functions keep their source text; an ES module
 * is lowered to `System.register`, and TypeScript is erased, by Babel.
 *
 * Every source line stays on its line and the function's prologue shares the
 * first line with the source, so the line numbers a program sees in its stack
 * traces are its own.
 */
export function createRuntimeArtifactTranslator(babel: BabelStandalone): RuntimeArtifactCompile {
  const parse = (source: string, format: Format, typeScript: boolean): BabelProgram =>
    (babel.packages.parser.parse(source, {
      allowNewTargetOutsideFunction: format === 'commonjs',
      allowReturnOutsideFunction: format === 'commonjs',
      attachComment: false,
      plugins: typeScript ? ['typescript', 'importAttributes'] : ['importAttributes'],
      ranges: false,
      sourceType: format === 'module' ? 'module' : 'script',
      tokens: false
    }) as { readonly program: BabelProgram }).program;

  // The source text a direct `eval` runs, with `import()` routed to the Module
  // Execution Engine and `await` through the Async Context, as a module's own
  // source is; it stays text for `eval`. A source that does not parse is left
  // for `eval` to reject.
  const instrumentEvalSource = (source: string): string => {
    let program: BabelProgram;
    try {
      program = parse(source, 'commonjs', false);
    } catch {
      return source;
    }
    return instrumentRuntime(source, program);
  };

  const translate = (source: string, program: BabelProgram, format: Format, typeScript: boolean): CompiledRuntimeArtifact => {
    const instrumented = instrumentRuntime(source, program);
    if (format === 'commonjs' && !typeScript) {
      return { format, code: runtimeArtifactFunctionText(format, instrumented) };
    }
    const transformed = babel.transform(instrumented, {
      ast: false,
      babelrc: false,
      code: true,
      configFile: false,
      sourceType: format === 'module' ? 'module' : 'script',
      parserOpts: {
        allowNewTargetOutsideFunction: format === 'commonjs',
        allowReturnOutsideFunction: format === 'commonjs',
        plugins: ['importAttributes']
      },
      generatorOpts: { comments: true, compact: false, retainLines: true },
      presets: typeScript
        ? [['typescript', { allExtensions: true, allowDeclareFields: true, onlyRemoveTypeImports: true }]]
        : [],
      plugins: [
        ...(typeScript ? [rejectNonErasableTypeScriptSyntax] : []),
        ...(format === 'module'
          ? [encodeJsonImportAttributes, 'transform-export-namespace-from', 'transform-modules-systemjs', supportTopLevelForAwait]
          : [])
      ]
    });
    if (typeof transformed.code !== 'string') {
      throw new SyntaxError('The Runtime Artifact Compiler produced no JavaScript');
    }
    return { format, code: runtimeArtifactFunctionText(format, transformed.code) };
  };

  return (kind, source) => {
    if (kind === 'eval') return { format: 'commonjs', code: instrumentEvalSource(source) };
    const prepared = blankShebang(source);
    const typeScript = kind.endsWith('-typescript');
    try {
      if (kind === 'module' || kind === 'module-typescript') {
        return translate(prepared, parse(prepared, 'module', typeScript), 'module', typeScript);
      }
      let script: BabelProgram;
      try {
        script = parse(prepared, 'commonjs', typeScript);
      } catch (error) {
        if (!isParseError(error)) throw error;
        if (kind === 'detect' || kind === 'detect-typescript') {
          // Node's syntax detection: a source that only parses as a module is one.
          let module: BabelProgram | undefined;
          try {
            module = parse(prepared, 'module', typeScript);
          } catch {
            // Neither parses: the script's error is the one to report.
          }
          if (module) return translate(prepared, module, 'module', typeScript);
        }
        if (typeScript) throw error;
        // A script Babel cannot parse is left to the platform, which may accept
        // syntax Babel does not; `import()` still reaches the Module Execution Engine.
        return {
          format: 'commonjs',
          code: runtimeArtifactFunctionText('commonjs', prepared.replace(/\bimport\s*\(/g, '__import__('))
        };
      }
      return translate(prepared, script, 'commonjs', typeScript);
    } catch (error) {
      throw normalizedError(error);
    }
  };
}

type BabelNode = {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly [key: string]: unknown;
};

type BabelExpression = BabelNode & {
  readonly operator?: string;
  readonly argument?: BabelExpression;
  readonly callee?: BabelNode;
  readonly await?: boolean;
  readonly right?: BabelNode;
};

type BabelProgram = BabelNode & {
  readonly body: readonly (BabelNode & { readonly expression?: BabelExpression })[];
};

type SourceEdit = { readonly start: number; readonly end: number; readonly text: string };

/**
 * The runtime instrumentation, as edits to the source text. Every edit comes
 * from the parsed program, so strings, comments and member names are never
 * touched, and an inserted call is separated from a keyword before it.
 */
function instrumentRuntime(source: string, program: BabelProgram): string {
  const edits: SourceEdit[] = [];
  const wrap = (node: BabelNode | undefined, call: string): void => {
    if (typeof node?.start !== 'number' || typeof node.end !== 'number') return;
    // The inner parentheses keep a comma expression a single argument.
    edits.push({ start: node.start, end: node.start, text: ` ${call}((` });
    edits.push({ start: node.end, end: node.end, text: '))' });
  };
  // Every top-level expression statement reports its value; only native
  // promises are then tracked.
  for (const statement of program.body) {
    const expression = statement.type === 'ExpressionStatement' ? statement.expression : undefined;
    if (!expression || expression.type === 'AwaitExpression') continue;
    wrap(
      expression.type === 'UnaryExpression' && expression.operator === 'void' && expression.argument
        ? expression.argument
        : expression,
      '__trackAsync'
    );
  }
  if (source.includes('import') || source.includes('await') || source.includes('eval')) {
    // A node's edits are collected before its descendants', which is the order
    // two edits at one offset must keep: the outer call opens first.
    const pending: BabelNode[] = [program];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (node.type === 'AwaitExpression') wrap((node as BabelExpression).argument, '__awaitInContext');
      if (node.type === 'ForOfStatement' && (node as BabelExpression).await === true) {
        wrap((node as BabelExpression).right, '__forAwaitInContext');
      }
      const importKeyword =
        node.type === 'ImportExpression'
          ? node
          : node.type === 'CallExpression' && (node as BabelExpression).callee?.type === 'Import'
            ? (node as BabelExpression).callee
            : undefined;
      if (typeof importKeyword?.start === 'number') {
        edits.push({ start: importKeyword.start, end: importKeyword.start + 'import'.length, text: '__import__' });
      }
      // A direct eval stays direct; the source it runs is instrumented first.
      // A spread source (`eval(...args)`) is evaluated as written.
      const call = node as BabelExpression & { readonly arguments?: readonly BabelNode[] };
      const evaluated = call.arguments?.[0];
      if (
        node.type === 'CallExpression' &&
        call.callee?.type === 'Identifier' &&
        call.callee.name === 'eval' &&
        evaluated &&
        evaluated.type !== 'SpreadElement'
      ) {
        wrap(evaluated, '__evalSource');
      }
      for (const key in node) {
        const child = node[key];
        if (typeof child !== 'object' || child === null) continue;
        if (Array.isArray(child)) {
          for (let index = child.length - 1; index >= 0; index -= 1) {
            if (isBabelNode(child[index])) pending.push(child[index]);
          }
        } else if (isBabelNode(child)) {
          pending.push(child);
        }
      }
    }
  }
  if (edits.length === 0) return source;
  // The sort is stable, so edits at one offset keep the order they were made in.
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function isBabelNode(value: unknown): value is BabelNode {
  return typeof value === 'object' && value !== null && typeof (value as BabelNode).type === 'string';
}

/** Blanks the interpreter line while keeping its newline, so later lines keep their numbers. */
function blankShebang(source: string): string {
  return source.startsWith('#!') ? source.replace(/^#![^\n]*/, '') : source;
}

function isParseError(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { reasonCode?: unknown }).reasonCode === 'string';
}

/** Babel names no file, so its message starts with a placeholder the caller replaces with the module identity. */
function normalizedError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  error.message = error.message.replace(/^unknown: /, '');
  return error;
}

type BabelCodeFramePath = Readonly<{
  buildCodeFrameError(message: string, constructor?: ErrorConstructor): Error;
}>;

type BabelModuleDeclarationPath = BabelCodeFramePath & Readonly<{
  node: {
    attributes?: readonly BabelImportAttribute[];
    source?: {
      extra?: unknown;
      loc?: { readonly start: { readonly column: number; readonly line: number } };
      value: string;
    };
  };
}>;

type BabelImportAttribute = Readonly<{
  key: Readonly<{ name?: string; value?: string }>;
  value: Readonly<{ value?: string }>;
}>;

type BabelForOfStatementPath = Readonly<{
  getFunctionParent(): unknown;
  node: { readonly await?: boolean };
}>;

type BabelProgramExitPath = Readonly<{
  traverse(visitor: Readonly<{ ObjectProperty(path: BabelObjectPropertyPath): void }>): void;
}>;

type BabelObjectPropertyPath = Readonly<{
  node: {
    key?: { readonly name?: string };
    value?: { async?: boolean; readonly type?: string };
  };
}>;

/** Moves a `{ type: "json" }` attribute into the specifier, where the System.register dependency list keeps it. */
function encodeJsonImportAttributes() {
  const encode = (path: BabelModuleDeclarationPath): void => {
    const { attributes, source } = path.node;
    if (!attributes || attributes.length === 0 || !source) return;
    const attribute = attributes[0];
    const key = attribute?.key.name ?? attribute?.key.value;
    if (attributes.length !== 1 || key !== 'type' || attribute.value.value !== 'json') {
      throw path.buildCodeFrameError('Only static import attributes with { type: "json" } are supported', SyntaxError);
    }
    const location = source.loc?.start ?? { line: 1, column: 0 };
    source.value = `${JSON_IMPORT_PREFIX}${JSON.stringify([source.value, location.line, location.column])}`;
    delete source.extra;
    path.node.attributes = [];
  };
  return {
    visitor: {
      ExportAllDeclaration: encode,
      ExportNamedDeclaration: encode,
      ImportDeclaration: encode
    }
  };
}

/** Babel's System.register output only makes `execute` async for a top-level `await`, not a top-level `for await`. */
function supportTopLevelForAwait() {
  let found = false;
  return {
    visitor: {
      ForOfStatement(path: BabelForOfStatementPath) {
        if (path.node.await && !path.getFunctionParent()) found = true;
      },
      Program: {
        exit(path: BabelProgramExitPath) {
          if (!found) return;
          let marked = false;
          path.traverse({
            ObjectProperty(propertyPath) {
              if (marked) return;
              const { key, value } = propertyPath.node;
              if (key?.name === 'execute' && value?.type === 'FunctionExpression') {
                value.async = true;
                marked = true;
              }
            }
          });
        }
      }
    }
  };
}

/** Only erasable TypeScript is accepted, as in Node's type stripping. */
function rejectNonErasableTypeScriptSyntax() {
  const reject = (description: string) => (path: BabelCodeFramePath): never => {
    throw path.buildCodeFrameError(
      `TypeScript ${description} requires code generation and is unsupported; only erasable syntax is accepted`,
      SyntaxError
    );
  };
  return {
    visitor: {
      TSEnumDeclaration: reject('enum declarations'),
      TSExportAssignment: reject('export assignments'),
      TSImportEqualsDeclaration: reject('import-equals declarations'),
      TSModuleDeclaration: reject('namespace declarations'),
      TSNamespaceExportDeclaration: reject('namespace exports'),
      TSParameterProperty: reject('parameter properties')
    }
  };
}
