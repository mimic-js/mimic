import type { Terminal } from '@xterm/xterm';
import type { Mimic, MimicProcess } from '@mimic-js/runtime';

const encoder = new TextEncoder();
const NEWLINE = 0x0a;
/** Moves the cursor home and erases the screen and the scrollback, as `clear` does. */
const CLEAR = '\x1b[H\x1b[2J\x1b[3J';

type RunningCommand = {
  readonly process: MimicProcess;
  readonly input: WritableStreamDefaultWriter<Uint8Array>;
  interrupted: boolean;
};

/**
 * A command line over a container whose processes have no terminal device: it
 * edits the line itself, runs each entered line as `sh -c`, and keeps the one
 * thing a shell would carry between lines, the working directory.
 */
export class ShellSession {
  #cwd: string;
  #line = '';
  #cursor = 0;
  #history: string[] = [];
  #historyIndex = 0;
  /** True from the Enter that submits a line until its prompt is drawn again. */
  #executing = false;
  /** What was typed while a line was being started; it is read once the prompt returns. */
  #typedAhead = '';
  #running: RunningCommand | undefined;
  #lastExitCode = 0;
  /** Whether the cursor is at the start of a line, where a prompt can be drawn. */
  #atLineStart = true;
  /**
   * What handling the current input has written so far, or nothing outside of
   * it. xterm parses the first write after an input at once and defers the
   * next ones, so an edit split over several writes can be painted half done.
   */
  #pendingOutput: string | undefined;
  #disposed = false;
  readonly #subscription: { dispose(): void };

  constructor(
    private readonly terminal: Terminal,
    private readonly container: Mimic,
    private readonly label: string,
    private readonly onCommandFinished: () => void,
    { cwd = container.workdir, line = '' }: { readonly cwd?: string; readonly line?: string } = {}
  ) {
    this.#cwd = cwd;
    this.#line = line;
    this.#cursor = line.length;
    this.#subscription = terminal.onData((data) => this.#receive(data));
    this.#drawLine();
  }

  dispose(): void {
    this.#disposed = true;
    this.#subscription.dispose();
    this.#running?.process.kill('SIGKILL');
  }

  #receive(data: string): void {
    this.#batch(() => this.#handle(data));
  }

  /** Runs `action` and writes what it wrote in one write, so that no frame shows half of it. */
  #batch(action: () => void): void {
    const outermost = this.#pendingOutput === undefined;
    if (outermost) this.#pendingOutput = '';
    try {
      action();
    } finally {
      if (outermost) {
        const output = this.#pendingOutput!;
        this.#pendingOutput = undefined;
        if (output) this.terminal.write(output);
      }
    }
  }

  #write(data: string): void {
    if (this.#pendingOutput === undefined) this.terminal.write(data);
    else this.#pendingOutput += data;
  }

  #handle(data: string): void {
    if (this.#executing) {
      if (this.#running) this.#receiveForProcess(data, this.#running);
      else this.#typedAhead += data;
      return;
    }
    switch (data) {
      case '\x1b[A':
        return this.#recall(this.#historyIndex - 1);
      case '\x1b[B':
        return this.#recall(this.#historyIndex + 1);
      case '\x1b[D':
        return this.#moveCursor(this.#cursor - 1);
      case '\x1b[C':
        return this.#moveCursor(this.#cursor + 1);
      case '\x1b[H':
      case '\x01':
        return this.#moveCursor(0);
      case '\x1b[F':
      case '\x05':
        return this.#moveCursor(this.#line.length);
      case '\x1b[3~':
        return this.#edit(this.#line.slice(0, this.#cursor) + this.#line.slice(this.#cursor + 1), this.#cursor);
    }
    if (data.startsWith('\x1b')) return;

    // Anything else is typed or pasted text, which may hold several lines.
    const characters = [...data];
    for (const [index, character] of characters.entries()) {
      if (this.#executing) {
        this.#typedAhead += characters.slice(index).join('');
        return;
      } else if (character === '\r') {
        // Output starts below the whole line, wherever in it the cursor is.
        this.#write(this.#movement(this.#cursor, this.#line.length) + (this.#endsRow(this.#line.length) ? '' : '\r\n'));
        const line = this.#line;
        this.#line = '';
        this.#cursor = 0;
        void this.#execute(line);
      } else if (character === '\x7f') {
        if (this.#cursor > 0) {
          this.#edit(this.#line.slice(0, this.#cursor - 1) + this.#line.slice(this.#cursor), this.#cursor - 1);
        }
      } else if (character === '\x03') {
        const toEnd = this.#movement(this.#cursor, this.#line.length);
        this.#line = '';
        this.#cursor = 0;
        this.#drawLine(`${toEnd}^C\r\n`);
      } else if (character === '\x0c') {
        this.#drawLine(CLEAR);
      } else if (character === '\x15') {
        this.#edit(this.#line.slice(this.#cursor), 0);
      } else if (character >= ' ') {
        this.#edit(
          this.#line.slice(0, this.#cursor) + character + this.#line.slice(this.#cursor),
          this.#cursor + character.length
        );
      }
    }
  }

  /** Input of a running command is sent a line at a time, as a terminal in canonical mode would. */
  #receiveForProcess(data: string, running: RunningCommand): void {
    if (data.startsWith('\x1b')) return;
    for (const character of data) {
      if (character === '\x03') {
        this.#write('^C');
        this.#atLineStart = false;
        // A program that ignores the interrupt is killed by the second one.
        running.process.kill(running.interrupted ? 'SIGKILL' : 'SIGINT');
        running.interrupted = true;
      } else if (character === '\x04') {
        void running.input.close().catch(() => undefined);
      } else if (character === '\r') {
        this.#write('\r\n');
        this.#atLineStart = true;
        void running.input.write(encoder.encode(`${this.#line}\n`)).catch(() => undefined);
        this.#line = '';
      } else if (character === '\x7f') {
        if (this.#line) {
          this.#line = this.#line.slice(0, -1);
          this.#write('\b \b');
        }
      } else if (character >= ' ') {
        this.#line += character;
        this.#write(character);
        this.#atLineStart = false;
      }
    }
  }

  async #execute(line: string): Promise<void> {
    this.#executing = true;
    const command = line.trim();
    if (command) {
      if (this.#history.at(-1) !== command) this.#history.push(command);
      const changeDirectory = /^cd(?:\s+(\S+))?$/.exec(command);
      if (command === 'clear') this.#write(CLEAR);
      else if (changeDirectory) await this.#changeDirectory(changeDirectory[1]);
      else await this.#run(command);
    }
    this.#historyIndex = this.#history.length;
    if (this.#disposed) return;
    const newline = this.#atLineStart ? '' : '\r\n';
    this.#atLineStart = true;
    this.#executing = false;
    const typedAhead = this.#typedAhead;
    this.#typedAhead = '';
    this.#batch(() => {
      this.#drawLine(newline);
      if (typedAhead) this.#handle(typedAhead);
    });
  }

  async #run(command: string): Promise<void> {
    try {
      const process = await this.container.spawn('sh', ['-c', command], {
        cwd: this.#cwd,
        // Programs see no terminal, and would otherwise print without colour.
        env: { FORCE_COLOR: '1' }
      });
      const running: RunningCommand = { process, input: process.input.getWriter(), interrupted: false };
      this.#running = running;
      await process.output.pipeTo(
        new WritableStream({
          write: (chunk) => {
            if (this.#disposed || chunk.byteLength === 0) return;
            this.#atLineStart = chunk[chunk.byteLength - 1] === NEWLINE;
            this.terminal.write(chunk);
          }
        })
      );
      this.#lastExitCode = await process.exit;
    } catch (error) {
      this.#lastExitCode = 1;
      if (!this.#disposed) this.#write(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    } finally {
      this.#running = undefined;
      this.#line = '';
      this.#cursor = 0;
      if (!this.#disposed) this.onCommandFinished();
    }
  }

  async #changeDirectory(target = this.container.workdir): Promise<void> {
    const path = resolvePath(target === '~' ? this.container.workdir : target, this.#cwd);
    try {
      if (!(await this.container.fs.stat(path)).isDirectory()) throw new Error('not a directory');
      this.#cwd = path;
      this.#lastExitCode = 0;
    } catch {
      this.#lastExitCode = 1;
      if (!this.#disposed) this.#write(`cd: ${target}: No such directory\r\n`);
    }
  }

  #recall(index: number): void {
    if (index < 0 || index > this.#history.length) return;
    this.#historyIndex = index;
    const line = this.#history[index] ?? '';
    this.#edit(line, line.length);
  }

  #moveCursor(cursor: number): void {
    this.#edit(this.#line, Math.max(0, Math.min(this.#line.length, cursor)));
  }

  /**
   * Shows `line` with the cursor at `cursor` by rewriting only what changed:
   * typing at the end writes the character alone, an edit inside the line
   * rewrites from the edit on and moves back, and a cursor movement only moves.
   */
  #edit(line: string, cursor: number): void {
    const previous = this.#line;
    let output = '';
    let at = this.#cursor;
    if (line !== previous) {
      let common = 0;
      while (common < line.length && common < previous.length && line[common] === previous[common]) common++;
      const rewritten = line.slice(common);
      output += this.#movement(at, common) + rewritten + (rewritten ? this.#settle(line.length) : '');
      if (previous.length > line.length) output += this.#erase(line.length, previous.length);
      at = line.length;
    }
    output += this.#movement(at, cursor);
    this.#line = line;
    this.#cursor = cursor;
    if (output) this.#write(output);
  }

  /** Draws the prompt and the line on a line of its own, after `before`, in one write. */
  #drawLine(before = ''): void {
    const arrowColour = this.#lastExitCode === 0 ? 32 : 31;
    const prompt = `\x1b[36m${this.#location()}\x1b[0m \x1b[${arrowColour}m❯\x1b[0m `;
    this.#write(
      `${before}${prompt}${this.#line}${this.#settle(this.#line.length)}${this.#movement(this.#line.length, this.#cursor)}`
    );
  }

  /** The cursor movement from one offset of the line to another, across the rows a long line wraps over. */
  #movement(from: number, to: number): string {
    const { cols } = this.terminal;
    const start = this.#promptWidth() + from;
    const end = this.#promptWidth() + to;
    const rows = Math.floor(end / cols) - Math.floor(start / cols);
    const columns = (end % cols) - (start % cols);
    return (
      (rows < 0 ? csi(-rows, 'A') : rows > 0 ? csi(rows, 'B') : '') +
      (columns < 0 ? csi(-columns, 'D') : columns > 0 ? csi(columns, 'C') : '')
    );
  }

  /** Erases what is left of a longer line, from the end of the line, where the cursor is. */
  #erase(end: number, previousEnd: number): string {
    const below = this.#row(previousEnd) > this.#row(end);
    if (!this.#endsRow(end)) return below ? '\x1b[J' : '\x1b[K';
    // Erasing a line from its first column also ends the line the row wraps
    // from; the row is blanked instead, and the rows below erased.
    return `\x1b[${this.terminal.cols}X${below ? '\x1b[B\x1b[J\x1b[A' : ''}`;
  }

  /**
   * A character written in the last column leaves the cursor there until the
   * next one; a space and a carriage return move it to the start of the next
   * row, where the offsets of `#movement` place it.
   */
  #settle(offset: number): string {
    return this.#endsRow(offset) ? ' \r' : '';
  }

  /** Whether the line up to `offset` fills its last row exactly. */
  #endsRow(offset: number): boolean {
    return (this.#promptWidth() + offset) % this.terminal.cols === 0;
  }

  #row(offset: number): number {
    return Math.floor((this.#promptWidth() + offset) / this.terminal.cols);
  }

  #promptWidth(): number {
    return this.#location().length + 3;
  }

  /** The working directory as the prompt shows it: relative to the repository when inside it. */
  #location(): string {
    const { workdir } = this.container;
    if (this.#cwd === workdir) return this.label;
    return this.#cwd.startsWith(`${workdir}/`) ? `${this.label}${this.#cwd.slice(workdir.length)}` : this.#cwd;
  }
}

/** A control sequence with a count, which a count of one may leave out. */
function csi(count: number, final: string): string {
  return `\x1b[${count === 1 ? '' : count}${final}`;
}

function resolvePath(path: string, base: string): string {
  const segments: string[] = [];
  for (const segment of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return `/${segments.join('/')}`;
}
