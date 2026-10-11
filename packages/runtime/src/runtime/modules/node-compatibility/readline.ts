import { EventEmitter } from './events';
import { nodeStringDecoder } from './string-decoder';

type TextDecoderLike = { write(chunk: unknown): string; end(): string };
const createUtf8Decoder = (): TextDecoderLike =>
  new (nodeStringDecoder.StringDecoder as unknown as new (encoding: string) => TextDecoderLike)('utf8');

type Writable = { write?: (chunk: string) => unknown; columns?: number };
type Readable = EventEmitter & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  pause?: () => unknown;
  resume?: () => unknown;
  setEncoding?: (encoding: string) => unknown;
};

type InterfaceOptions = {
  input?: Readable;
  output?: Writable;
  completer?: unknown;
  terminal?: boolean;
  prompt?: string;
  crlfDelay?: number;
  history?: string[];
  historySize?: number;
  signal?: AbortSignal;
};

export type Key = {
  sequence: string;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
};

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE = '\x1b';

/**
 * `node:readline` and `node:readline/promises`. An Interface reads its input
 * stream: it emits `line` for each line, answers `question()`, iterates lines
 * asynchronously, and closes when the input ends. On a terminal it reads
 * keypresses, edits the line and echoes it as Node does; `emitKeypressEvents()`
 * turns a stream's input into the `keypress` events prompt libraries read.
 */
export function createReadlineBuiltin(): unknown {
  const readline = createReadline(false);
  return { ...readline, promises: createReadlinePromisesBuiltin(), default: readline };
}

export function createReadlinePromisesBuiltin(): unknown {
  const promises = createReadline(true);
  return { ...promises, default: promises };
}

function createReadline(promiseApi: boolean) {
  class Interface extends EventEmitter {
    closed = false;
    line = '';
    cursor = 0;
    terminal: boolean;
    history: string[];
    readonly input: Readable | undefined;
    readonly output: Writable | undefined;
    private promptText: string;
    private paused = false;
    private pendingQuestion: ((answer: string) => void) | undefined;
    private readonly decoder = createUtf8Decoder();
    private sawReturnAt = 0;
    private readonly crlfDelay: number;
    private readonly historySize: number;
    private historyIndex = -1;
    private readonly detach: () => void;

    constructor(
      input?: Readable | InterfaceOptions,
      output?: Writable,
      _completer?: unknown,
      terminal?: boolean
    ) {
      super();
      // `createInterface(options)` or the older `createInterface(input, output, completer, terminal)`.
      const options: InterfaceOptions =
        input && typeof (input as Readable).on !== 'function'
          ? (input as InterfaceOptions)
          : { input: input as Readable | undefined, output, terminal };
      this.input = options.input;
      this.output = options.output;
      this.terminal = options.terminal ?? Boolean((options.output as { isTTY?: boolean } | undefined)?.isTTY);
      this.promptText = options.prompt ?? '> ';
      this.crlfDelay = Math.max(100, options.crlfDelay ?? 100);
      this.history = options.history ? [...options.history] : [];
      this.historySize = options.historySize ?? 30;
      this.detach = this.attach();
      if (options.signal) {
        if (options.signal.aborted) queueMicrotask(() => this.close());
        else options.signal.addEventListener('abort', () => this.close(), { once: true });
      }
    }

    private attach(): () => void {
      const input = this.input;
      if (!input) return () => undefined;
      const onEnd = () => {
        const rest = this.decoder.end();
        if (rest) this.receive(rest);
        if (!this.terminal && this.line.length > 0) this.commitLine();
        this.close();
      };
      if (this.terminal) {
        emitKeypressEvents(input, this);
        input.setRawMode?.(true);
        const onKeypress = (sequence: string | undefined, key: Key | undefined) => this.keypress(sequence, key);
        input.on('keypress', onKeypress);
        input.on('end', onEnd);
        input.resume?.();
        return () => {
          input.removeListener('keypress', onKeypress);
          input.removeListener('end', onEnd);
        };
      }
      const onData = (chunk: unknown) => this.receive(decodeChunk(this.decoder, chunk));
      input.on('data', onData);
      input.on('end', onEnd);
      input.resume?.();
      return () => {
        input.removeListener('data', onData);
        input.removeListener('end', onEnd);
      };
    }

    private receive(text: string): void {
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (character !== '\n' && character !== '\r') continue;
        // A `\r\n` pair is one line end, also when it arrives in two chunks.
        if (character === '\n' && index === 0 && Date.now() - this.sawReturnAt <= this.crlfDelay && this.line === '') {
          start = 1;
          this.sawReturnAt = 0;
          continue;
        }
        this.line += text.slice(start, index);
        this.commitLine();
        if (character === '\r') {
          if (text[index + 1] === '\n') index += 1;
          else this.sawReturnAt = Date.now();
        }
        start = index + 1;
        if (this.closed) return;
      }
      this.line += text.slice(start);
      this.cursor = this.line.length;
    }

    private commitLine(): void {
      const line = this.line;
      this.line = '';
      this.cursor = 0;
      if (this.terminal && line && this.historySize > 0 && this.history[0] !== line) {
        this.history.unshift(line);
        if (this.history.length > this.historySize) this.history.length = this.historySize;
      }
      this.historyIndex = -1;
      const question = this.pendingQuestion;
      this.pendingQuestion = undefined;
      if (question) question(line);
      else this.emit('line', line);
    }

    private keypress(sequence: string | undefined, key: Key | undefined): void {
      if (this.closed) return;
      const name = key?.name;
      if (key?.ctrl && name === 'c') {
        if (this.listenerCount('SIGINT') > 0) this.emit('SIGINT');
        else this.close();
        return;
      }
      if (key?.ctrl && name === 'd') {
        if (this.line.length === 0) this.close();
        return;
      }
      if (name === 'return' || name === 'enter') {
        this.output?.write?.('\r\n');
        this.commitLine();
        return;
      }
      if (name === 'backspace') {
        if (this.cursor === 0) return;
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor -= 1;
        this.refreshLine();
        return;
      }
      if (name === 'delete') {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this.refreshLine();
        return;
      }
      if (name === 'left' || name === 'right' || name === 'home' || name === 'end') {
        this.cursor =
          name === 'left' ? Math.max(0, this.cursor - 1)
          : name === 'right' ? Math.min(this.line.length, this.cursor + 1)
          : name === 'home' ? 0
          : this.line.length;
        this.refreshLine();
        return;
      }
      if (name === 'up' || name === 'down') {
        const next = this.historyIndex + (name === 'up' ? 1 : -1);
        if (next < -1 || next >= this.history.length) return;
        this.historyIndex = next;
        this.line = next === -1 ? '' : this.history[next]!;
        this.cursor = this.line.length;
        this.refreshLine();
        return;
      }
      if (key?.ctrl || key?.meta || !sequence || sequence.startsWith(ESCAPE)) return;
      const text = sequence.replace(/[\r\n]/gu, '');
      this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
      this.cursor += text.length;
      if (this.cursor === this.line.length) this.output?.write?.(text);
      else this.refreshLine();
    }

    private refreshLine(): void {
      if (!this.terminal) return;
      this.output?.write?.(`\r\x1b[2K${this.promptText}${this.line}`);
      const back = this.line.length - this.cursor;
      if (back > 0) this.output?.write?.(`\x1b[${back}D`);
    }

    get [Symbol.toStringTag](): string {
      return 'Interface';
    }

    close(): void {
      if (this.closed) return;
      this.closed = true;
      if (this.terminal) this.input?.setRawMode?.(false);
      this.detach();
      this.input?.pause?.();
      this.pendingQuestion = undefined;
      this.emit('close');
    }

    pause(): this {
      if (this.paused) return this;
      this.paused = true;
      this.input?.pause?.();
      this.emit('pause');
      return this;
    }

    resume(): this {
      if (!this.paused) return this;
      this.paused = false;
      this.input?.resume?.();
      this.emit('resume');
      return this;
    }

    prompt(_preserveCursor?: boolean): void {
      if (this.closed) throw closedError();
      if (this.paused) this.resume();
      this.output?.write?.(this.promptText);
    }

    setPrompt(prompt: string): void {
      this.promptText = String(prompt);
    }

    getPrompt(): string {
      return this.promptText;
    }

    getCursorPos(): { rows: number; cols: number } {
      return { rows: 0, cols: this.promptText.length + this.cursor };
    }

    write(data?: unknown, key?: Key): void {
      if (this.closed) throw closedError();
      if (this.paused) this.resume();
      if (this.terminal) {
        if (key) this.keypress(typeof data === 'string' ? data : key.sequence, key);
        else if (typeof data === 'string') for (const [sequence, parsed] of parseKeys(data)) this.keypress(sequence, parsed);
        return;
      }
      if (data !== undefined && data !== null) this.receive(String(data));
    }

    protected ask(query: string, answer: (line: string) => void): void {
      if (this.closed) throw closedError();
      if (this.pendingQuestion) {
        this.prompt();
        return;
      }
      this.pendingQuestion = answer;
      if (this.paused) this.resume();
      this.output?.write?.(query);
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<string> {
      const lines: string[] = [];
      const waiters: Array<(result: IteratorResult<string>) => void> = [];
      let done = this.closed;
      const onLine = (line: string) => {
        const waiter = waiters.shift();
        if (waiter) waiter({ value: line, done: false });
        else lines.push(line);
      };
      const onClose = () => {
        done = true;
        cleanup();
        for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
      };
      const cleanup = () => {
        this.removeListener('line', onLine);
        this.removeListener('close', onClose);
      };
      this.on('line', onLine);
      this.on('close', onClose);
      const iterator: AsyncIterableIterator<string> = {
        next: () => {
          if (lines.length > 0) return Promise.resolve({ value: lines.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return: () => {
          cleanup();
          this.close();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return iterator;
        }
      };
      return iterator;
    }
  }

  class CallbackInterface extends Interface {
    question(query: string, options?: unknown, callback?: (answer: string) => void): void {
      const answer = typeof options === 'function' ? (options as (answer: string) => void) : callback;
      const signal = typeof options === 'object' ? (options as { signal?: AbortSignal } | null)?.signal : undefined;
      if (signal?.aborted) return;
      this.ask(String(query), (line) => answer?.(line));
    }
  }

  class PromiseInterface extends Interface {
    question(query: string, options: { signal?: AbortSignal } = {}): Promise<string> {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(abortError(signal));
          return;
        }
        const onAbort = () => reject(abortError(signal!));
        signal?.addEventListener('abort', onAbort, { once: true });
        const onClose = () => reject(closedError());
        this.once('close', onClose);
        try {
          this.ask(String(query), (line) => {
            signal?.removeEventListener('abort', onAbort);
            this.removeListener('close', onClose);
            resolve(line);
          });
        } catch (error) {
          this.removeListener('close', onClose);
          reject(error);
        }
      });
    }
  }

  const InterfaceClass = promiseApi ? PromiseInterface : CallbackInterface;
  const createInterface = (
    input?: Readable | InterfaceOptions,
    output?: Writable,
    completer?: unknown,
    terminal?: boolean
  ) => new InterfaceClass(input, output, completer, terminal);

  if (promiseApi) {
    /** `readline/promises.Readline`: cursor actions queued until `commit()`. */
    class Readline {
      private actions: string[] = [];
      constructor(private readonly stream: Writable, _options?: { autoCommit?: boolean }) {}
      clearLine(dir: number): this {
        this.actions.push(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
        return this;
      }
      clearScreenDown(): this {
        this.actions.push('\x1b[0J');
        return this;
      }
      cursorTo(x: number, y?: number): this {
        this.actions.push(cursorSequence(x, y));
        return this;
      }
      moveCursor(dx: number, dy: number): this {
        this.actions.push(moveSequence(dx, dy));
        return this;
      }
      commit(): Promise<void> {
        const pending = this.actions.join('');
        this.actions = [];
        if (pending) this.stream.write?.(pending);
        return Promise.resolve();
      }
      rollback(): this {
        this.actions = [];
        return this;
      }
    }
    return { Interface: PromiseInterface, Readline, createInterface };
  }

  return {
    Interface: CallbackInterface,
    createInterface,
    cursorTo,
    clearScreenDown,
    clearLine,
    moveCursor,
    emitKeypressEvents
  };
}

function decodeChunk(decoder: { write(chunk: unknown): string }, chunk: unknown): string {
  return typeof chunk === 'string' ? chunk : decoder.write(chunk);
}

function closedError(): Error {
  return Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
}

function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
    name: 'AbortError',
    code: 'ABORT_ERR'
  });
}

function cursorSequence(x: number, y?: number): string {
  return typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`;
}

function moveSequence(dx: number, dy: number): string {
  let sequence = '';
  if (dx < 0) sequence += `\x1b[${-dx}D`;
  else if (dx > 0) sequence += `\x1b[${dx}C`;
  if (dy < 0) sequence += `\x1b[${-dy}A`;
  else if (dy > 0) sequence += `\x1b[${dy}B`;
  return sequence;
}

function writeAnsi(stream: Writable | undefined, sequence: string, callback?: () => void): boolean {
  if (sequence) stream?.write?.(sequence);
  if (callback) queueMicrotask(callback);
  return true;
}

function cursorTo(stream: Writable | undefined, x: number, y?: number | (() => void), callback?: () => void): boolean {
  const resolvedCallback = typeof y === 'function' ? y : callback;
  return writeAnsi(stream, cursorSequence(x, typeof y === 'number' ? y : undefined), resolvedCallback);
}

function clearScreenDown(stream?: Writable, callback?: () => void): boolean {
  return writeAnsi(stream, '\x1b[0J', callback);
}

function clearLine(stream?: Writable, dir?: number | (() => void), callback?: () => void): boolean {
  const resolvedCallback = typeof dir === 'function' ? dir : callback;
  const direction = typeof dir === 'number' ? dir : 0;
  return writeAnsi(stream, direction < 0 ? '\x1b[1K' : direction > 0 ? '\x1b[0K' : '\x1b[2K', resolvedCallback);
}

function moveCursor(stream: Writable | undefined, dx: number, dy: number, callback?: () => void): boolean {
  return writeAnsi(stream, moveSequence(dx, dy), callback);
}

/** Makes `stream` emit `keypress` for what it reads, once per stream. */
export function emitKeypressEvents(stream: Readable, _interface?: unknown): void {
  const marked = stream as Readable & { [KEYPRESS_DECODER]?: true };
  if (marked[KEYPRESS_DECODER]) return;
  marked[KEYPRESS_DECODER] = true;
  const decoder = createUtf8Decoder();
  const onData = (chunk: unknown) => {
    if (stream.listenerCount('keypress') === 0) return;
    for (const [sequence, key] of parseKeys(decodeChunk(decoder, chunk))) stream.emit('keypress', sequence, key);
  };
  const onNewListener = (event: string) => {
    if (event !== 'keypress') return;
    stream.on('data', onData);
    stream.removeListener('newListener', onNewListener);
  };
  if (stream.listenerCount('keypress') > 0) stream.on('data', onData);
  else stream.on('newListener', onNewListener);
}

const CSI_KEYS: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', E: 'clear', F: 'end', H: 'home', Z: 'tab',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
  '1~': 'home', '2~': 'insert', '3~': 'delete', '4~': 'end', '5~': 'pageup', '6~': 'pagedown',
  '7~': 'home', '8~': 'end', '11~': 'f1', '12~': 'f2', '13~': 'f3', '14~': 'f4', '15~': 'f5',
  '17~': 'f6', '18~': 'f7', '19~': 'f8', '20~': 'f9', '21~': 'f10', '23~': 'f11', '24~': 'f12'
};

/** Splits terminal input into keypresses the way Node's `emitKeys` names them. */
export function parseKeys(input: string): Array<[string, Key]> {
  const keys: Array<[string, Key]> = [];
  const characters = [...input];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const key: Key = { sequence: character, name: undefined, ctrl: false, meta: false, shift: false };
    if (character === ESCAPE && index + 1 < characters.length) {
      let next = characters[index + 1]!;
      if (next === '[' || next === 'O') {
        let body = '';
        let cursor = index + 2;
        while (cursor < characters.length && /[0-9;]/u.test(characters[cursor]!)) body += characters[cursor++];
        const final = characters[cursor];
        if (final !== undefined) {
          const parameters = body.split(';');
          const modifier = Number(parameters[1] ?? 1) - 1;
          const code = final === '~' ? `${parameters[0]}~` : final;
          key.sequence = characters.slice(index, cursor + 1).join('');
          key.code = `${next}${code}`;
          key.name = CSI_KEYS[code];
          key.shift = Boolean(modifier & 1) || final === 'Z';
          key.meta = Boolean(modifier & 10);
          key.ctrl = Boolean(modifier & 4);
          keys.push([key.sequence, key]);
          index = cursor;
          continue;
        }
      }
      // Escape and a key: the key with meta.
      next = characters[index + 1]!;
      const [, inner] = parseKeys(next)[0]!;
      keys.push([character + next, { ...inner, sequence: character + next, meta: true }]);
      index += 1;
      continue;
    }
    if (character === '\r') key.name = 'return';
    else if (character === '\n') key.name = 'enter';
    else if (character === '\t') key.name = 'tab';
    else if (character === '\b' || character === '\x7f') key.name = 'backspace';
    else if (character === ESCAPE) key.name = 'escape';
    else if (character === ' ') key.name = 'space';
    else if (character.length === 1 && character.charCodeAt(0) <= 0x1a) {
      key.name = String.fromCharCode(character.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
      key.ctrl = true;
    } else if (/^[0-9a-z]$/u.test(character)) key.name = character;
    else if (/^[A-Z]$/u.test(character)) {
      key.name = character.toLowerCase();
      key.shift = true;
    }
    keys.push([character, key]);
  }
  return keys;
}
