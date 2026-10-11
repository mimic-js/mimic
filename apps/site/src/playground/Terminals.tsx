import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Mimic } from '@mimic-js/mimic';
import { ShellSession } from './shell-session';

type TerminalsProps = {
  readonly container: Mimic;
  /** The name the prompt shows for the working directory. */
  readonly label: string;
  /** The directory each terminal starts in. */
  readonly cwd: string;
  /** A command the first terminal has typed at its prompt, for the user to run. */
  readonly initialLine?: string;
  readonly onCommandFinished: () => void;
};

/** Command lines over one container; a second one stays usable while a server runs in the first. */
export function Terminals(props: TerminalsProps) {
  const [ids, setIds] = useState<readonly number[]>([1]);
  const [activeId, setActiveId] = useState(1);
  const nextId = useRef(2);
  // A terminal is shown once its prompt is drawn: until a new one has drawn
  // its prompt, the one shown before stays, rather than an empty terminal.
  const [drawn, setDrawn] = useState<ReadonlySet<number>>(() => new Set());
  const [shownId, setShownId] = useState(activeId);
  if (shownId !== activeId && drawn.has(activeId)) setShownId(activeId);

  const onDrawn = useCallback((id: number) => setDrawn((current) => new Set(current).add(id)), []);

  const add = () => {
    const id = nextId.current++;
    setIds((current) => [...current, id]);
    setActiveId(id);
  };

  const close = (id: number) => {
    const remaining = ids.filter((candidate) => candidate !== id);
    setIds(remaining);
    if (id === activeId) setActiveId(remaining.at(-1) ?? 0);
  };

  return (
    <section className="terminals" aria-label="Terminal">
      <div className="tabs" role="tablist">
        {ids.map((id) => (
          <div key={id} className="tab" role="tab" aria-selected={id === activeId}>
            <button type="button" className="tab-label" onClick={() => setActiveId(id)}>
              Terminal {id}
            </button>
            {ids.length > 1 && (
              <button type="button" className="tab-close" aria-label={`Close terminal ${id}`} onClick={() => close(id)} />
            )}
          </div>
        ))}
        <button type="button" className="tab-add" aria-label="New terminal" onClick={add}>
          +
        </button>
      </div>
      {ids.map((id) => (
        <TerminalView
          key={id}
          {...props}
          id={id}
          initialLine={id === 1 ? props.initialLine : undefined}
          shown={id === shownId && drawn.has(id)}
          onDrawn={onDrawn}
        />
      ))}
    </section>
  );
}

type TerminalViewProps = TerminalsProps & {
  readonly id: number;
  readonly shown: boolean;
  /** Called once the first prompt is drawn. */
  readonly onDrawn: (id: number) => void;
};

/**
 * Every terminal keeps its place and its size, and only the shown one is
 * visible: a terminal taken out of the layout would be refitted, and drawn
 * again, in the frame it is shown again.
 */
function TerminalView({ container, label, cwd, initialLine, onCommandFinished, id, shown, onDrawn }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const onCommandFinishedRef = useRef(onCommandFinished);
  onCommandFinishedRef.current = onCommandFinished;

  useEffect(() => {
    const host = hostRef.current!;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0b0d12', foreground: '#d7dbe4', cursor: '#d7dbe4' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    // Fitted before the prompt is drawn, so that the prompt is laid out once.
    const fitToHost = () => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    };
    fitToHost();
    const resizeObserver = new ResizeObserver(fitToHost);
    resizeObserver.observe(host);
    const session = new ShellSession(terminal, container, label, () => onCommandFinishedRef.current(), {
      cwd,
      line: initialLine
    });
    let disposed = false;
    // Writes are parsed in order: this one is parsed once the prompt is.
    terminal.write('', () => {
      if (!disposed) onDrawn(id);
    });
    terminalRef.current = terminal;
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      session.dispose();
      terminal.dispose();
    };
  }, [container, label, cwd, initialLine, id, onDrawn]);

  // Before the paint, so that the shown terminal is painted focused.
  useLayoutEffect(() => {
    if (shown) terminalRef.current?.focus();
  }, [shown]);

  return (
    <div className="terminal-frame" data-shown={shown || undefined} aria-hidden={!shown}>
      <div ref={hostRef} className="terminal-host" />
    </div>
  );
}
