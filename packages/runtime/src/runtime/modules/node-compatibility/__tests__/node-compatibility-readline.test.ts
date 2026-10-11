import { describe, expect, test } from 'vitest';

import { EventEmitter } from '../events';
import { createReadlineBuiltin, createReadlinePromisesBuiltin, emitKeypressEvents, parseKeys } from '../readline';

type Interface = EventEmitter & {
  line: string;
  question(query: string, callback: (answer: string) => void): void;
  close(): void;
  write(data: string): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
};
type Readline = { createInterface(options: object): Interface };
type PromiseInterface = Omit<Interface, 'question'> & { question(query: string): Promise<string> };

function input(): EventEmitter & { isTTY?: boolean; setRawMode?: (mode: boolean) => void } {
  return new EventEmitter();
}

function output(): { written: string[]; write(chunk: string): boolean } {
  const written: string[] = [];
  return { written, write: (chunk) => written.push(chunk) > 0 };
}

describe('node:readline', () => {
  test('emits a line for every line of its input, across chunks and line endings, and closes at its end', () => {
    const readline = createReadlineBuiltin() as Readline;
    const source = input();
    const rl = readline.createInterface({ input: source });
    const lines: string[] = [];
    let closed = false;
    rl.on('line', (line: string) => lines.push(line));
    rl.on('close', () => (closed = true));

    source.emit('data', new TextEncoder().encode('first\r\nsec'));
    source.emit('data', 'ond\nthi');
    source.emit('data', 'rd\r');
    source.emit('data', '\nlast');
    source.emit('end');

    expect(lines).toEqual(['first', 'second', 'third', 'last']);
    expect(closed).toBe(true);
  });

  test('answers a question with the next line instead of emitting it', () => {
    const readline = createReadlineBuiltin() as Readline;
    const source = input();
    const sink = output();
    const rl = readline.createInterface({ input: source, output: sink });
    const lines: string[] = [];
    const answers: string[] = [];
    rl.on('line', (line: string) => lines.push(line));

    rl.question('Name? ', (answer) => answers.push(answer));
    source.emit('data', 'Ada\nafter\n');

    expect(sink.written).toEqual(['Name? ']);
    expect(answers).toEqual(['Ada']);
    expect(lines).toEqual(['after']);
  });

  test('iterates its lines asynchronously until the input ends', async () => {
    const readline = createReadlineBuiltin() as Readline;
    const source = input();
    const rl = readline.createInterface({ input: source, crlfDelay: Infinity });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const line of rl) lines.push(line);
    })();

    source.emit('data', 'a\nb\n');
    await Promise.resolve();
    source.emit('data', 'c');
    source.emit('end');
    await reading;

    expect(lines).toEqual(['a', 'b', 'c']);
  });

  test('readline/promises questions resolve with the answer and reject once the interface closes', async () => {
    const readline = createReadlinePromisesBuiltin() as { createInterface(options: object): PromiseInterface };
    const source = input();
    const rl = readline.createInterface({ input: source, output: output() });

    const answer = rl.question('Continue? ');
    source.emit('data', 'yes\n');
    await expect(answer).resolves.toBe('yes');

    const unanswered = rl.question('Again? ');
    rl.close();
    await expect(unanswered).rejects.toMatchObject({ code: 'ERR_USE_AFTER_CLOSE' });
  });

  test('a terminal interface edits the line from keypresses and echoes it', () => {
    const readline = createReadlineBuiltin() as Readline;
    const source = input();
    const modes: boolean[] = [];
    source.isTTY = true;
    source.setRawMode = (mode) => modes.push(mode);
    const sink = output();
    const rl = readline.createInterface({ input: source, output: sink, terminal: true, prompt: '$ ' });
    const lines: string[] = [];
    rl.on('line', (line: string) => lines.push(line));

    source.emit('data', 'lx\x7fs -a\x1b[D\x1b[D\x1b[D\x1b[Dl\r');

    expect(lines).toEqual(['lls -a']);
    expect(sink.written.join('')).toContain('l');
    rl.close();
    expect(modes).toEqual([true, false]);
  });

  test('emitKeypressEvents names keys as Node does', () => {
    const source = input();
    const keys: Array<{ name?: string; ctrl: boolean; shift: boolean; meta: boolean }> = [];
    emitKeypressEvents(source);
    source.on('keypress', (_sequence: string, key: { name?: string; ctrl: boolean; shift: boolean; meta: boolean }) =>
      keys.push({ name: key.name, ctrl: key.ctrl, shift: key.shift, meta: key.meta })
    );

    source.emit('data', 'aB \r\x03\x1b[A\x1b[3~\x1b[1;5C\x1bx');

    expect(keys).toEqual([
      { name: 'a', ctrl: false, shift: false, meta: false },
      { name: 'b', ctrl: false, shift: true, meta: false },
      { name: 'space', ctrl: false, shift: false, meta: false },
      { name: 'return', ctrl: false, shift: false, meta: false },
      { name: 'c', ctrl: true, shift: false, meta: false },
      { name: 'up', ctrl: false, shift: false, meta: false },
      { name: 'delete', ctrl: false, shift: false, meta: false },
      { name: 'right', ctrl: true, shift: false, meta: false },
      { name: 'x', ctrl: false, shift: false, meta: true }
    ]);
    expect(parseKeys('\t')[0]![1].name).toBe('tab');
  });
});
