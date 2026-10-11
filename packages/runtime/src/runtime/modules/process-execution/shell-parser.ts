import type {
  ShellAndOr,
  ShellAssignment,
  ShellCommand,
  ShellList,
  ShellListItem,
  ShellParameterOperator,
  ShellPipeline,
  ShellRedirection,
  ShellSimpleCommand,
  ShellWord,
  ShellWordPart
} from './shell-ast';

type ShellOperator = '&&' | '||' | ';;' | ';' | '&' | '|' | '(' | ')' | '<' | '>' | '>>' | '<&' | '>&';

type Token =
  | Readonly<{ readonly type: 'word'; readonly word: ShellWord; readonly reserved?: string }>
  | Readonly<{ readonly type: 'operator'; readonly value: ShellOperator }>
  | Readonly<{ readonly type: 'io-number'; readonly fd: number }>
  | Readonly<{ readonly type: 'newline' }>
  | Readonly<{ readonly type: 'end' }>;

const LIST_TERMINATORS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAMETER_NAME_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/;
const PARAMETER_OPERATOR_PATTERN = /^(?::-|:=|:\+|:\?|%%|##|[-=+?%#])/;

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellSyntaxError';
  }
}

export function parseShellScript(source: string): ShellList {
  const parser = new ShellParser(source, 0);
  const list = parser.parseList();
  parser.expectEnd();
  return list;
}

class ShellParser {
  #position: number;
  #peeked: Token | undefined;

  constructor(
    private readonly source: string,
    position: number
  ) {
    this.#position = position;
  }

  /** The offset after the last consumed token; only meaningful with no lookahead pending. */
  get position(): number {
    return this.#position;
  }

  expectEnd(): void {
    const token = this.peek();
    if (token.type !== 'end') throw unexpected(token);
  }

  expectOperator(operator: ShellOperator): void {
    const token = this.next();
    if (token.type !== 'operator' || token.value !== operator) {
      throw new ShellSyntaxError(`syntax error: expected "${operator}" but found ${describe(token)}`);
    }
  }

  parseList(): ShellList {
    const items: ShellListItem[] = [];
    this.skipNewlines();
    while (!this.atListEnd()) {
      const andOr = this.parseAndOr();
      const separator = this.peek();
      let background = false;
      if (separator.type === 'operator' && separator.value === '&') {
        this.next();
        background = true;
      } else if (separator.type === 'operator' && separator.value === ';') {
        this.next();
      } else if (separator.type !== 'newline' && !this.atListEnd()) {
        throw unexpected(separator);
      }
      items.push({ andOr, background });
      this.skipNewlines();
    }
    return { items };
  }

  private atListEnd(): boolean {
    const token = this.peek();
    if (token.type === 'end') return true;
    if (token.type === 'operator') return token.value === ')' || token.value === ';;';
    return token.type === 'word' && token.reserved !== undefined && LIST_TERMINATORS.has(token.reserved);
  }

  private parseAndOr(): ShellAndOr {
    const pipelines = [this.parsePipeline()];
    const operators: ('&&' | '||')[] = [];
    while (true) {
      const token = this.peek();
      if (token.type !== 'operator' || (token.value !== '&&' && token.value !== '||')) break;
      this.next();
      this.skipNewlines();
      operators.push(token.value);
      pipelines.push(this.parsePipeline());
    }
    return { pipelines, operators };
  }

  private parsePipeline(): ShellPipeline {
    let negated = false;
    while (this.peekReserved() === '!') {
      this.next();
      negated = !negated;
    }
    const commands = [this.parseCommand()];
    while (true) {
      const token = this.peek();
      if (token.type !== 'operator' || token.value !== '|') break;
      this.next();
      this.skipNewlines();
      commands.push(this.parseCommand());
    }
    return { negated, commands };
  }

  private parseCommand(): ShellCommand {
    const token = this.peek();
    if (token.type === 'operator' && token.value === '(') {
      this.next();
      const start = this.#position;
      const body = this.parseList();
      this.peek();
      const source = this.source.slice(start, this.#lexStart);
      this.expectOperator(')');
      return { kind: 'subshell', body, source, redirections: this.parseRedirections() };
    }
    switch (token.type === 'word' ? token.reserved : undefined) {
      case '{': {
        this.next();
        const body = this.parseList();
        this.expectReserved('}');
        return { kind: 'group', body, redirections: this.parseRedirections() };
      }
      case 'if':
        return this.parseIf();
      case 'for':
        return this.parseFor();
      case 'while':
      case 'until': {
        this.next();
        const condition = this.parseList();
        this.expectReserved('do');
        const body = this.parseList();
        this.expectReserved('done');
        return {
          kind: 'while',
          until: (token as { reserved: string }).reserved === 'until',
          condition,
          body,
          redirections: this.parseRedirections()
        };
      }
      case 'case':
        return this.parseCase();
      case 'function':
        throw new ShellSyntaxError('syntax error: function definitions are not supported');
      case 'select':
        throw new ShellSyntaxError('syntax error: select loops are not supported');
      case '[[':
        throw new ShellSyntaxError('syntax error: [[ ]] conditional expressions are not supported; use [ ]');
      default:
        return this.parseSimple();
    }
  }

  private parseIf(): ShellCommand {
    this.next();
    const clauses: { condition: ShellList; body: ShellList }[] = [];
    let otherwise: ShellList | undefined;
    while (true) {
      const condition = this.parseList();
      this.expectReserved('then');
      clauses.push({ condition, body: this.parseList() });
      const keyword = this.peekReserved();
      if (keyword === 'elif') {
        this.next();
        continue;
      }
      if (keyword === 'else') {
        this.next();
        otherwise = this.parseList();
      }
      this.expectReserved('fi');
      break;
    }
    return { kind: 'if', clauses, ...(otherwise ? { otherwise } : {}), redirections: this.parseRedirections() };
  }

  private parseFor(): ShellCommand {
    this.next();
    const variable = this.next();
    if (variable.type !== 'word' || variable.reserved === undefined || !NAME_PATTERN.test(variable.reserved)) {
      throw new ShellSyntaxError(`syntax error: for requires a variable name but found ${describe(variable)}`);
    }
    this.skipNewlines();
    let items: ShellWord[] | undefined;
    if (this.peekReserved() === 'in') {
      this.next();
      items = [];
      while (true) {
        const token = this.peek();
        if (token.type !== 'word') break;
        items.push(token.word);
        this.next();
      }
    }
    const separator = this.peek();
    if (separator.type === 'operator' && separator.value === ';') this.next();
    this.skipNewlines();
    this.expectReserved('do');
    const body = this.parseList();
    this.expectReserved('done');
    return {
      kind: 'for',
      variable: variable.reserved,
      ...(items ? { items } : {}),
      body,
      redirections: this.parseRedirections()
    };
  }

  private parseCase(): ShellCommand {
    this.next();
    const subject = this.next();
    if (subject.type !== 'word') {
      throw new ShellSyntaxError(`syntax error: case requires a word but found ${describe(subject)}`);
    }
    this.skipNewlines();
    this.expectReserved('in');
    this.skipNewlines();
    const clauses: { patterns: ShellWord[]; body: ShellList }[] = [];
    while (this.peekReserved() !== 'esac') {
      const open = this.peek();
      if (open.type === 'operator' && open.value === '(') this.next();
      const patterns: ShellWord[] = [];
      while (true) {
        const pattern = this.next();
        if (pattern.type !== 'word') {
          throw new ShellSyntaxError(`syntax error: case requires a pattern but found ${describe(pattern)}`);
        }
        patterns.push(pattern.word);
        const separator = this.peek();
        if (separator.type !== 'operator' || separator.value !== '|') break;
        this.next();
      }
      this.expectOperator(')');
      const body = this.parseList();
      clauses.push({ patterns, body });
      const terminator = this.peek();
      if (terminator.type === 'operator' && terminator.value === ';;') this.next();
      this.skipNewlines();
    }
    this.expectReserved('esac');
    return { kind: 'case', subject: subject.word, clauses, redirections: this.parseRedirections() };
  }

  private parseSimple(): ShellSimpleCommand {
    const assignments: ShellAssignment[] = [];
    const words: ShellWord[] = [];
    const redirections: ShellRedirection[] = [];
    while (true) {
      const token = this.peek();
      if (token.type === 'word') {
        this.next();
        const assignment = words.length === 0 ? splitAssignment(token.word) : undefined;
        const following = this.peek();
        const opensParenthesis = following.type === 'operator' && following.value === '(';
        if (assignment) {
          if (opensParenthesis && assignment.value.parts.length === 0) {
            throw new ShellSyntaxError('syntax error: array assignments are not supported');
          }
          assignments.push(assignment);
          continue;
        }
        if (opensParenthesis && words.length === 0 && assignments.length === 0) {
          throw new ShellSyntaxError('syntax error: function definitions are not supported');
        }
        words.push(token.word);
        continue;
      }
      if (token.type === 'io-number' || isRedirectionOperator(token)) {
        redirections.push(this.parseRedirection());
        continue;
      }
      break;
    }
    if (words.length === 0 && assignments.length === 0 && redirections.length === 0) {
      throw unexpected(this.peek());
    }
    return { kind: 'simple', assignments, words, redirections };
  }

  private parseRedirections(): readonly ShellRedirection[] {
    const redirections: ShellRedirection[] = [];
    while (true) {
      const token = this.peek();
      if (token.type !== 'io-number' && !isRedirectionOperator(token)) return redirections;
      redirections.push(this.parseRedirection());
    }
  }

  private parseRedirection(): ShellRedirection {
    let token = this.next();
    let fd: number | undefined;
    if (token.type === 'io-number') {
      fd = token.fd;
      token = this.next();
    }
    if (token.type !== 'operator') throw unexpected(token);
    const operator = token.value;
    const target = this.next();
    if (target.type !== 'word') {
      throw new ShellSyntaxError(`syntax error: redirection ${operator} requires a target but found ${describe(target)}`);
    }
    const kind =
      operator === '<'
        ? 'input'
        : operator === '>'
          ? 'output'
          : operator === '>>'
            ? 'append'
            : operator === '<&'
              ? 'duplicate-input'
              : 'duplicate-output';
    return { fd: fd ?? (kind === 'input' || kind === 'duplicate-input' ? 0 : 1), kind, target: target.word };
  }

  private expectReserved(word: string): void {
    const token = this.next();
    if (token.type !== 'word' || token.reserved !== word) {
      throw new ShellSyntaxError(`syntax error: expected "${word}" but found ${describe(token)}`);
    }
  }

  private peekReserved(): string | undefined {
    const token = this.peek();
    return token.type === 'word' ? token.reserved : undefined;
  }

  private skipNewlines(): void {
    while (this.peek().type === 'newline') this.next();
  }

  private peek(): Token {
    this.#peeked ??= this.lex();
    return this.#peeked;
  }

  private next(): Token {
    const token = this.peek();
    this.#peeked = undefined;
    this.#position = this.#lexEnd;
    return token;
  }

  #lexStart = 0;
  #lexEnd = 0;

  private lex(): Token {
    const source = this.source;
    let index = this.#position;
    while (index < source.length) {
      const character = source[index]!;
      if (character === ' ' || character === '\t' || character === '\r') index += 1;
      else if (character === '\\' && source[index + 1] === '\n') index += 2;
      else break;
    }
    if (source[index] === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
    }
    this.#lexStart = index;
    const finish = <Value extends Token>(token: Value, end: number): Value => {
      this.#lexEnd = end;
      return token;
    };
    if (index >= source.length) return finish({ type: 'end' }, index);
    const character = source[index]!;
    if (character === '\n') return finish({ type: 'newline' }, index + 1);

    const ioNumber = /^\d+(?=[<>])/.exec(source.slice(index, index + 12));
    if (ioNumber) return finish({ type: 'io-number', fd: Number(ioNumber[0]) }, index + ioNumber[0].length);

    const two = source.slice(index, index + 2);
    if (two === '<<') throw new ShellSyntaxError('syntax error: here-documents (<<) are not supported');
    if (two === '<>') throw new ShellSyntaxError('syntax error: read-write redirection (<>) is not supported');
    if (two === '&>') {
      throw new ShellSyntaxError('syntax error: &> redirection is not supported; use "> file 2>&1"');
    }
    if (two === '<(' || two === '>(') {
      throw new ShellSyntaxError(`syntax error: process substitution ${two}…) is not supported`);
    }
    if (two === '>|') return finish({ type: 'operator', value: '>' }, index + 2);
    if (two === '&&' || two === '||' || two === ';;' || two === '>>' || two === '<&' || two === '>&') {
      return finish({ type: 'operator', value: two }, index + 2);
    }
    if (';&|()<>'.includes(character)) {
      return finish({ type: 'operator', value: character as ShellOperator }, index + 1);
    }

    const { word, end } = this.readWord(index);
    const only = word.parts.length === 1 ? word.parts[0]! : undefined;
    const reserved = only?.kind === 'literal' && !only.quoted ? only.value : undefined;
    return finish({ type: 'word', word, ...(reserved === undefined ? {} : { reserved }) }, end);
  }

  private readWord(start: number): { readonly word: ShellWord; readonly end: number } {
    const source = this.source;
    const parts = new PartBuilder();
    let index = start;
    if (source[index] === '~' && endsTildePrefix(source[index + 1])) {
      parts.push({ kind: 'tilde' });
      index += 1;
    }
    while (index < source.length) {
      const character = source[index]!;
      if (' \t\r\n;&|()<>'.includes(character)) break;
      if (character === '\\') {
        if (index + 1 >= source.length) throw new ShellSyntaxError('syntax error: trailing backslash');
        if (source[index + 1] !== '\n') parts.literal(source[index + 1]!, true);
        index += 2;
        continue;
      }
      if (character === "'") {
        const close = source.indexOf("'", index + 1);
        if (close === -1) throw new ShellSyntaxError('syntax error: unterminated single quote');
        parts.literal(source.slice(index + 1, close), true, true);
        index = close + 1;
        continue;
      }
      if (character === '"') {
        index = this.readDoubleQuoted(index + 1, parts);
        continue;
      }
      if (character === '`') {
        index = this.readBackticks(index, parts, false);
        continue;
      }
      if (character === '$') {
        index = this.readDollar(index, parts, false);
        continue;
      }
      parts.literal(character, false);
      index += 1;
      // `NAME=~/path` expands the tilde like a word start does.
      if (
        character === '=' &&
        source[index] === '~' &&
        endsTildePrefix(source[index + 1]) &&
        parts.isAssignmentPrefix()
      ) {
        parts.push({ kind: 'tilde' });
        index += 1;
      }
    }
    return { word: { parts: parts.finish() }, end: index };
  }

  /** Reads from just after an opening double quote and returns the offset after the closing quote. */
  private readDoubleQuoted(start: number, parts: PartBuilder): number {
    const source = this.source;
    let index = start;
    parts.literal('', true, true);
    while (true) {
      if (index >= source.length) throw new ShellSyntaxError('syntax error: unterminated double quote');
      const character = source[index]!;
      if (character === '"') return index + 1;
      if (character === '\\') {
        const escaped = source[index + 1];
        if (escaped === '\n') {
          index += 2;
          continue;
        }
        // POSIX: inside double quotes a backslash escapes only $ ` " \ and newline.
        if (escaped !== undefined && '$`"\\'.includes(escaped)) {
          parts.literal(escaped, true);
          index += 2;
          continue;
        }
        parts.literal('\\', true);
        index += 1;
        continue;
      }
      if (character === '`') {
        index = this.readBackticks(index, parts, true);
        continue;
      }
      if (character === '$') {
        index = this.readDollar(index, parts, true);
        continue;
      }
      parts.literal(character, true);
      index += 1;
    }
  }

  private readBackticks(start: number, parts: PartBuilder, quoted: boolean): number {
    const source = this.source;
    let inner = '';
    let index = start + 1;
    while (true) {
      if (index >= source.length) throw new ShellSyntaxError('syntax error: unterminated backquote');
      const character = source[index]!;
      if (character === '`') break;
      if (character === '\\' && index + 1 < source.length && '$`\\'.includes(source[index + 1]!)) {
        inner += source[index + 1]!;
        index += 2;
        continue;
      }
      inner += character;
      index += 1;
    }
    parts.push({ kind: 'command', body: parseShellScript(inner), quoted });
    return index + 1;
  }

  private readDollar(start: number, parts: PartBuilder, quoted: boolean): number {
    const source = this.source;
    const following = source[start + 1];
    if (following === '(') {
      if (source[start + 2] === '(') {
        const arithmetic = scanArithmetic(source, start + 3);
        if (arithmetic) {
          parts.push({ kind: 'arithmetic', expression: arithmetic.expression, quoted });
          return arithmetic.end;
        }
      }
      const nested = new ShellParser(source, start + 2);
      const body = nested.parseList();
      nested.expectOperator(')');
      parts.push({ kind: 'command', body, quoted });
      return nested.position;
    }
    if (following === '{') return this.readBracedParameter(start, parts, quoted);
    const name = following === undefined ? undefined : /^(?:[A-Za-z_][A-Za-z0-9_]*|\d|[@*#?$!-])/.exec(
      source.slice(start + 1, start + 1 + 256)
    );
    if (!name) {
      parts.literal('$', quoted);
      return start + 1;
    }
    parts.push({ kind: 'parameter', name: name[0], quoted });
    return start + 1 + name[0].length;
  }

  private readBracedParameter(start: number, parts: PartBuilder, quoted: boolean): number {
    const source = this.source;
    let index = start + 2;
    const rest = (): string => source.slice(index, index + 256);
    const lengthName = /^#((?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-]))\}/.exec(rest());
    if (lengthName) {
      parts.push({ kind: 'parameter', name: lengthName[1]!, quoted, length: true });
      return index + lengthName[0].length;
    }
    const name = PARAMETER_NAME_PATTERN.exec(rest());
    if (!name) throw new ShellSyntaxError(`syntax error: bad substitution ${describeSubstitution(source, start)}`);
    index += name[0].length;
    if (source[index] === '}') {
      parts.push({ kind: 'parameter', name: name[0], quoted });
      return index + 1;
    }
    const operator = PARAMETER_OPERATOR_PATTERN.exec(rest());
    if (!operator) {
      throw new ShellSyntaxError(
        `syntax error: unsupported parameter expansion ${describeSubstitution(source, start)}`
      );
    }
    index += operator[0].length;
    const isPattern = operator[0][0] === '%' || operator[0][0] === '#';
    const argument = this.readBraceArgument(index, isPattern ? false : quoted);
    parts.push({
      kind: 'parameter',
      name: name[0],
      quoted,
      operator: operator[0] as ShellParameterOperator,
      argument: argument.word
    });
    return argument.end;
  }

  /** Reads the word of `${name<op>word}` up to its closing brace. */
  private readBraceArgument(start: number, quoted: boolean): { readonly word: ShellWord; readonly end: number } {
    const source = this.source;
    const parts = new PartBuilder();
    let index = start;
    while (true) {
      if (index >= source.length) throw new ShellSyntaxError('syntax error: unterminated ${ } expansion');
      const character = source[index]!;
      if (character === '}') return { word: { parts: parts.finish() }, end: index + 1 };
      if (character === '\\' && index + 1 < source.length) {
        parts.literal(source[index + 1]!, true);
        index += 2;
        continue;
      }
      if (character === "'" && !quoted) {
        const close = source.indexOf("'", index + 1);
        if (close === -1) throw new ShellSyntaxError('syntax error: unterminated single quote');
        parts.literal(source.slice(index + 1, close), true, true);
        index = close + 1;
        continue;
      }
      if (character === '"') {
        index = this.readDoubleQuoted(index + 1, parts);
        continue;
      }
      if (character === '`') {
        index = this.readBackticks(index, parts, quoted);
        continue;
      }
      if (character === '$') {
        index = this.readDollar(index, parts, quoted);
        continue;
      }
      parts.literal(character, quoted);
      index += 1;
    }
  }
}

class PartBuilder {
  readonly #parts: ShellWordPart[] = [];
  #text = '';
  #quoted = false;
  #pending = false;

  literal(value: string, quoted: boolean, keepEmpty = false): void {
    if (this.#pending && this.#quoted !== quoted) this.flush();
    if (value === '' && !keepEmpty) return;
    this.#quoted = quoted;
    this.#text += value;
    this.#pending = true;
  }

  push(part: ShellWordPart): void {
    this.flush();
    this.#parts.push(part);
  }

  isAssignmentPrefix(): boolean {
    return this.#parts.length === 0 && !this.#quoted && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(this.#text);
  }

  finish(): readonly ShellWordPart[] {
    this.flush();
    return this.#parts;
  }

  private flush(): void {
    if (!this.#pending) return;
    this.#parts.push({ kind: 'literal', value: this.#text, quoted: this.#quoted });
    this.#text = '';
    this.#pending = false;
  }
}

function splitAssignment(word: ShellWord): ShellAssignment | undefined {
  const first = word.parts[0];
  if (first?.kind !== 'literal' || first.quoted) return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.value);
  if (!match) return undefined;
  const remainder = first.value.slice(match[0].length);
  return {
    name: match[1]!,
    value: {
      parts: [
        ...(remainder === '' ? [] : [{ kind: 'literal' as const, value: remainder, quoted: false }]),
        ...word.parts.slice(1)
      ]
    }
  };
}

function scanArithmetic(
  source: string,
  start: number
): { readonly expression: string; readonly end: number } | undefined {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) {
        return source[index + 1] === ')'
          ? { expression: source.slice(start, index), end: index + 2 }
          : undefined;
      }
      depth -= 1;
    }
  }
  return undefined;
}

function endsTildePrefix(character: string | undefined): boolean {
  return character === undefined || character === '/' || ' \t\r\n;&|()<>'.includes(character);
}

function isRedirectionOperator(token: Token): boolean {
  return (
    token.type === 'operator' &&
    (token.value === '<' || token.value === '>' || token.value === '>>' || token.value === '<&' || token.value === '>&')
  );
}

function describeSubstitution(source: string, start: number): string {
  const close = source.indexOf('}', start);
  return close === -1 ? source.slice(start, start + 24) : source.slice(start, close + 1);
}

function describe(token: Token): string {
  switch (token.type) {
    case 'end':
      return 'end of script';
    case 'newline':
      return 'newline';
    case 'operator':
      return `"${token.value}"`;
    case 'io-number':
      return `"${token.fd}"`;
    case 'word':
      return token.reserved === undefined ? 'a word' : `"${token.reserved}"`;
  }
}

function unexpected(token: Token): ShellSyntaxError {
  return new ShellSyntaxError(`syntax error: unexpected ${describe(token)}`);
}
