import { resolvePosixPath } from './posix-path';
import type { ShellList, ShellWord, ShellWordPart } from './shell-ast';

export interface ShellExpansionContext {
  readonly cwd: string;
  readonly nounset: boolean;
  /** Variables and the special parameters other than `@` and `*`. */
  parameter(name: string): string | undefined;
  positional(): readonly string[];
  assign(name: string, value: string): void;
  /** Runs a command substitution and returns its raw standard output. */
  substitute(body: ShellList): Promise<string>;
  /** Entry names of an absolute directory path, or `undefined` when it cannot be listed. */
  readDirectory(path: string): Promise<readonly string[] | undefined>;
  fileKind(path: string): Promise<'file' | 'directory' | undefined>;
}

export class ShellExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellExpansionError';
  }
}

type Segment = { readonly text: string; readonly quoted: boolean };
type PatternCharacter = { readonly character: string; readonly literal: boolean };

/** Expands command words into fields: parameter/command/arithmetic expansion, field splitting, then globbing. */
export async function expandShellWords(
  words: readonly ShellWord[],
  context: ShellExpansionContext
): Promise<string[]> {
  const result: string[] = [];
  for (const word of words) {
    for (const field of await expandFields(word, context, true)) {
      const matches = hasActiveGlob(field) ? await expandGlob(field, context) : undefined;
      if (matches && matches.length > 0) result.push(...matches);
      else result.push(joinField(field));
    }
  }
  return result;
}

/** Expands a word that yields exactly one string: assignments, redirection targets, `case` subjects. */
export async function expandShellWord(word: ShellWord, context: ShellExpansionContext): Promise<string> {
  return (await expandFields(word, context, false)).map(joinField).join(' ');
}

/** Expands a `case` pattern or `${name%pattern}` word into an anchored matcher. */
export async function expandShellPattern(word: ShellWord, context: ShellExpansionContext): Promise<RegExp> {
  const characters = (await expandFields(word, context, false)).flatMap((field, index) => [
    ...(index > 0 ? [{ character: ' ', literal: true }] : []),
    ...patternCharacters(field)
  ]);
  return new RegExp(`^(?:${globSource(characters, false)})$`);
}

async function expandFields(
  word: ShellWord,
  context: ShellExpansionContext,
  split: boolean
): Promise<Segment[][]> {
  const fields: Segment[][] = [[]];
  let breakPending = false;
  let emptyQuotedPositional = false;
  const separators = split ? fieldSeparators(context) : undefined;

  const add = (text: string, quoted: boolean): void => {
    if (breakPending) {
      if (fields.at(-1)!.length > 0) fields.push([]);
      breakPending = false;
    }
    fields.at(-1)!.push({ text, quoted });
  };
  const newField = (): void => {
    if (fields.at(-1)!.length > 0) fields.push([]);
    breakPending = false;
  };
  const addUnquoted = (value: string): void => {
    if (value === '') return;
    if (!separators) {
      add(value, false);
      return;
    }
    const pieces = value.split(separators.all).filter((piece) => piece !== '');
    if (separators.leading.test(value) || pieces.length === 0) breakPending = true;
    pieces.forEach((piece, index) => {
      if (index > 0) newField();
      add(piece, false);
    });
    if (separators.trailing.test(value)) breakPending = true;
  };
  const addValue = (value: string, quoted: boolean): void => {
    if (quoted) add(value, true);
    else addUnquoted(value);
  };

  const expandParts = async (parts: readonly ShellWordPart[]): Promise<void> => {
    for (const part of parts) {
      switch (part.kind) {
        case 'literal':
          add(part.value, part.quoted);
          break;
        case 'tilde':
          add(context.parameter('HOME') ?? '~', true);
          break;
        case 'command':
          addValue((await context.substitute(part.body)).replace(/\n+$/, ''), part.quoted);
          break;
        case 'arithmetic':
          addValue(String(evaluateArithmetic(part.expression, context)), part.quoted);
          break;
        case 'parameter':
          await expandParameter(part);
          break;
      }
    }
  };

  const expandParameter = async (part: Extract<ShellWordPart, { kind: 'parameter' }>): Promise<void> => {
    const positional = part.name === '@' || part.name === '*';
    if (positional && !part.operator && !part.length) {
      const values = context.positional();
      if (part.name === '*' && (part.quoted || !split)) {
        add(values.join(' '), part.quoted);
        return;
      }
      if (values.length === 0 && part.quoted) emptyQuotedPositional = true;
      values.forEach((value, index) => {
        if (index > 0) {
          if (split) newField();
          else add(' ', part.quoted);
        }
        addValue(value, part.quoted);
      });
      return;
    }
    const value = positional ? context.positional().join(' ') : context.parameter(part.name);
    const isSet = positional ? context.positional().length > 0 : value !== undefined;
    if (part.length) {
      addValue(String((value ?? '').length), part.quoted);
      return;
    }
    const operator = part.operator;
    const argument = part.argument ?? { parts: [] };
    if (!operator) {
      if (value === undefined && context.nounset) {
        throw new ShellExpansionError(`${part.name}: parameter not set`);
      }
      addValue(value ?? '', part.quoted);
      return;
    }
    if (operator[0] === '%' || operator[0] === '#') {
      const pattern = await expandShellPattern(argument, context);
      addValue(removePattern(value ?? '', pattern, operator), part.quoted);
      return;
    }
    const useAlternative = operator.startsWith(':') ? !isSet || value === '' : !isSet;
    switch (operator.at(-1)) {
      case '-':
        if (useAlternative) await expandParts(argument.parts);
        else addValue(value ?? '', part.quoted);
        return;
      case '=': {
        if (!useAlternative) {
          addValue(value ?? '', part.quoted);
          return;
        }
        if (!/^[A-Za-z_]/.test(part.name)) {
          throw new ShellExpansionError(`${part.name}: cannot assign in this way`);
        }
        const assigned = await expandShellWord(argument, context);
        context.assign(part.name, assigned);
        addValue(assigned, part.quoted);
        return;
      }
      case '+':
        if (!useAlternative) await expandParts(argument.parts);
        return;
      case '?': {
        if (!useAlternative) {
          addValue(value ?? '', part.quoted);
          return;
        }
        const message = await expandShellWord(argument, context);
        throw new ShellExpansionError(`${part.name}: ${message || 'parameter not set'}`);
      }
    }
  };

  await expandParts(word.parts);
  // `"$@"` with no positional parameters yields no field at all, not an empty one.
  if (emptyQuotedPositional && split && fields.length === 1 && joinField(fields[0]!) === '') return [];
  return fields.filter((field) => field.some((segment) => segment.quoted || segment.text !== ''));
}

function fieldSeparators(
  context: ShellExpansionContext
): { readonly all: RegExp; readonly leading: RegExp; readonly trailing: RegExp } | undefined {
  const separators = context.parameter('IFS') ?? ' \t\n';
  if (separators === '') return undefined;
  const set = `[${separators.replace(/[\\\]^-]/g, '\\$&')}]`;
  return { all: new RegExp(`${set}+`), leading: new RegExp(`^${set}`), trailing: new RegExp(`${set}$`) };
}

function joinField(field: readonly Segment[]): string {
  return field.map((segment) => segment.text).join('');
}

function hasActiveGlob(field: readonly Segment[]): boolean {
  return field.some((segment) => !segment.quoted && /[*?[]/.test(segment.text));
}

function patternCharacters(field: readonly Segment[]): PatternCharacter[] {
  return field.flatMap((segment) =>
    [...segment.text].map((character) => ({ character, literal: segment.quoted }))
  );
}

async function expandGlob(field: readonly Segment[], context: ShellExpansionContext): Promise<string[]> {
  const characters = patternCharacters(field);
  const components: PatternCharacter[][] = [[]];
  for (const entry of characters) {
    if (entry.character === '/') components.push([]);
    else components.at(-1)!.push(entry);
  }
  const absolute = characters[0]?.character === '/';
  const directoriesOnly = characters.at(-1)?.character === '/';
  let candidates = [absolute ? '/' : ''];
  let mustVerify = false;
  for (const component of components) {
    if (component.length === 0) continue;
    const text = component.map((entry) => entry.character).join('');
    if (!component.some((entry) => !entry.literal && '*?['.includes(entry.character))) {
      candidates = candidates.map((base) => joinPath(base, text));
      mustVerify = true;
      continue;
    }
    const matcher = new RegExp(`^(?:${globSource(component, true)})$`);
    const includeHidden = component[0]!.character === '.';
    const next: string[] = [];
    for (const base of candidates) {
      if (mustVerify && (await context.fileKind(resolvePosixPath(base, context.cwd))) !== 'directory') continue;
      const entries = await context.readDirectory(resolvePosixPath(base || '.', context.cwd));
      for (const name of [...(entries ?? [])].sort()) {
        if (name.startsWith('.') && !includeHidden) continue;
        if (matcher.test(name)) next.push(joinPath(base, name));
      }
    }
    candidates = next;
    mustVerify = false;
  }
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (mustVerify || directoriesOnly) {
      const kind = await context.fileKind(resolvePosixPath(candidate, context.cwd));
      if (kind === undefined || (directoriesOnly && kind !== 'directory')) continue;
    }
    matches.push(directoriesOnly ? `${candidate}/` : candidate);
  }
  return matches;
}

function joinPath(base: string, name: string): string {
  return base === '' ? name : base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
}

/** Translates shell pattern characters into regular expression source. */
function globSource(characters: readonly PatternCharacter[], pathComponent: boolean): string {
  const any = pathComponent ? '[^/]' : '[\\s\\S]';
  let source = '';
  for (let index = 0; index < characters.length; index += 1) {
    const { character, literal } = characters[index]!;
    if (literal) {
      source += escapeRegExp(character);
    } else if (character === '*') {
      source += `${any}*`;
    } else if (character === '?') {
      source += any;
    } else if (character === '[') {
      const bracket = bracketExpression(characters, index);
      if (bracket) {
        source += bracket.source;
        index = bracket.end;
      } else {
        source += '\\[';
      }
    } else {
      source += escapeRegExp(character);
    }
  }
  return source;
}

function bracketExpression(
  characters: readonly PatternCharacter[],
  start: number
): { readonly source: string; readonly end: number } | undefined {
  let index = start + 1;
  const negated = characters[index]?.character === '!' || characters[index]?.character === '^';
  if (negated) index += 1;
  let body = '';
  for (let first = true; index < characters.length; index += 1, first = false) {
    const { character } = characters[index]!;
    if (character === ']' && !first) {
      return { source: `[${negated ? '^' : ''}${body}]`, end: index };
    }
    body += /[\\\]^[]/.test(character) ? `\\${character}` : character;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function removePattern(value: string, pattern: RegExp, operator: string): string {
  const suffix = operator[0] === '%';
  const longest = operator.length === 2;
  // A suffix starts at `index`; a prefix spans everything before `value.length - index`.
  for (let step = 0; step <= value.length; step += 1) {
    const index = longest ? step : value.length - step;
    if (suffix) {
      if (pattern.test(value.slice(index))) return value.slice(0, index);
    } else if (pattern.test(value.slice(0, value.length - index))) {
      return value.slice(value.length - index);
    }
  }
  return value;
}

type ArithmeticToken =
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'name'; readonly value: string }
  | { readonly type: 'operator'; readonly value: string };

const ARITHMETIC_TOKEN =
  /\s*(?:(0[xX][0-9a-fA-F]+|\d+)|([A-Za-z_][A-Za-z0-9_]*)|(<<=|>>=|\|\||&&|==|!=|<=|>=|<<|>>|[-+*/%&|^]=|[-+*/%<>=!~&|^?:()]))/y;

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10
};

function evaluateArithmetic(expression: string, context: ShellExpansionContext): number {
  const source = expression.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\d+|[#?$!])\}|([A-Za-z_][A-Za-z0-9_]*|\d|[#?$!]))/g,
    (_match, braced: string | undefined, bare: string | undefined) => context.parameter(braced ?? bare!) ?? '0'
  );
  const tokens: ArithmeticToken[] = [];
  ARITHMETIC_TOKEN.lastIndex = 0;
  while (ARITHMETIC_TOKEN.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(ARITHMETIC_TOKEN.lastIndex))) break;
    const match = ARITHMETIC_TOKEN.exec(source);
    if (!match) throw new ShellExpansionError(`arithmetic syntax error in "${expression.trim()}"`);
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ type: 'name', value: match[2] });
    else tokens.push({ type: 'operator', value: match[3]! });
  }
  let index = 0;
  const fail = (): never => {
    throw new ShellExpansionError(`arithmetic syntax error in "${expression.trim()}"`);
  };
  const peekOperator = (): string | undefined => {
    const token = tokens[index];
    return token?.type === 'operator' ? token.value : undefined;
  };
  const variable = (name: string): number => {
    const value = Number(context.parameter(name) ?? '0');
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  };
  const apply = (operator: string, left: number, right: number): number => {
    switch (operator) {
      case '||':
        return left !== 0 || right !== 0 ? 1 : 0;
      case '&&':
        return left !== 0 && right !== 0 ? 1 : 0;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      case '&':
        return left & right;
      case '==':
        return left === right ? 1 : 0;
      case '!=':
        return left !== right ? 1 : 0;
      case '<':
        return left < right ? 1 : 0;
      case '<=':
        return left <= right ? 1 : 0;
      case '>':
        return left > right ? 1 : 0;
      case '>=':
        return left >= right ? 1 : 0;
      case '<<':
        return left << right;
      case '>>':
        return left >> right;
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
      case '%':
        if (right === 0) throw new ShellExpansionError('division by zero');
        return operator === '/' ? Math.trunc(left / right) : left % right;
      default:
        return fail();
    }
  };
  const parseAssignment = (): number => {
    const target = tokens[index];
    const operator = tokens[index + 1];
    if (
      target?.type === 'name' &&
      operator?.type === 'operator' &&
      (operator.value === '=' || /^(?:[-+*/%&|^]|<<|>>)=$/.test(operator.value))
    ) {
      index += 2;
      const right = parseAssignment();
      const value =
        operator.value === '=' ? right : apply(operator.value.slice(0, -1), variable(target.value), right);
      context.assign(target.value, String(value));
      return value;
    }
    return parseTernary();
  };
  const parseTernary = (): number => {
    const condition = parseBinary(1);
    if (peekOperator() !== '?') return condition;
    index += 1;
    const whenTrue = parseAssignment();
    if (peekOperator() !== ':') fail();
    index += 1;
    const whenFalse = parseTernary();
    return condition !== 0 ? whenTrue : whenFalse;
  };
  const parseBinary = (minimum: number): number => {
    let left = parseUnary();
    while (true) {
      const operator = peekOperator();
      const precedence = operator === undefined ? undefined : BINARY_PRECEDENCE[operator];
      if (operator === undefined || precedence === undefined || precedence < minimum) return left;
      index += 1;
      left = apply(operator, left, parseBinary(precedence + 1));
    }
  };
  const parseUnary = (): number => {
    const token = tokens[index];
    if (!token) return fail();
    index += 1;
    if (token.type === 'number') return token.value;
    if (token.type === 'name') return variable(token.value);
    switch (token.value) {
      case '-':
        return -parseUnary();
      case '+':
        return parseUnary();
      case '!':
        return parseUnary() === 0 ? 1 : 0;
      case '~':
        return ~parseUnary();
      case '(': {
        const value = parseAssignment();
        if (peekOperator() !== ')') fail();
        index += 1;
        return value;
      }
      default:
        return fail();
    }
  };
  if (tokens.length === 0) return 0;
  const result = parseAssignment();
  if (index !== tokens.length) fail();
  return result;
}
