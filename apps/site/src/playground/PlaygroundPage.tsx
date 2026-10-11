import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Mimic } from '@mimic-js/mimic';
import { EditorPane } from './EditorPane';
import { examples, exampleFromSearch, type Example } from './examples';
import { FileTree } from './FileTree';
import { downloadRepository, repositoryFromSearch, type Repository } from './github-archive';
import { Preview, usePublishedEndpoints } from './Preview';
import { Terminals } from './Terminals';
import { SiteMark } from '../site/SiteMark';
import '@xterm/xterm/css/xterm.css';
import './playground.css';

const FILES_POLL_INTERVAL_MS = 1000;

type Session =
  | { readonly phase: 'loading'; readonly step: string }
  | { readonly phase: 'ready'; readonly container: Mimic }
  | { readonly phase: 'failed'; readonly message: string };

/**
 * `/playground?repo=owner/name[&ref=]` or `/playground?example=<id>` opens a
 * repository or an example; `/playground` alone shows the repository form.
 * The router mounts a new page for another query, and a page hosts one
 * container at a time.
 */
export default function PlaygroundPage({ search }: { readonly search: string }) {
  const [example] = useState(() => exampleFromSearch(search));
  const [repository] = useState(() => (example ? example.repository : repositoryFromSearch(search)));
  return repository || example ? <Playground repository={repository} example={example} /> : <RepositoryForm />;
}

function RepositoryForm() {
  return (
    <div className="app">
      <header className="topbar">
        <SiteMark />
        <span className="example-name">Playground</span>
      </header>
      <main className="playground-home">
        <h1>Repository playground</h1>
        <p>Opens a public GitHub repository in the browser: its files in an editor, and a terminal to run it.</p>
        <RepositoryInput autoFocus />
        <ExamplePicker />
      </main>
    </div>
  );
}

/** The examples known to start in the playground, by stack; choosing one opens it. */
function ExamplePicker() {
  const [open, setOpen] = useState(false);
  const stacks = [...new Set(examples.map((example) => example.stack))];
  return (
    <div className="example-picker">
      <button type="button" className="example-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        or choose a tested example
      </button>
      {open &&
        stacks.map((stack) => (
          <section key={stack} className="example-group" aria-label={stack}>
            <h2>{stack}</h2>
            <ul>
              {examples
                .filter((example) => example.stack === stack)
                .map((example) => (
                  <li key={example.id}>
                    <a href={`/playground?${new URLSearchParams({ example: example.id })}`}>
                      <span className="example-title">{example.title}</span>
                      {example.partly && <PartlyBadge reason={example.partly} />}
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function PartlyBadge({ reason }: { readonly reason: string }) {
  return (
    <span className="partly-badge" title={reason}>
      partly works
    </span>
  );
}

/** Navigates to the repository that was entered; a page hosts one container, so opening another reloads it. */
function RepositoryInput({ initial = '', autoFocus = false }: { readonly initial?: string; readonly autoFocus?: boolean }) {
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const search = new URLSearchParams({ repo: value.trim() }).toString();
    if (repositoryFromSearch(search)) window.location.assign(`/playground?${search}`);
  };
  return (
    <form className="repository-input" onSubmit={submit}>
      <input
        aria-label="GitHub repository"
        placeholder="owner/repository"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">Open</button>
    </form>
  );
}

type PlaygroundProps = {
  /** Nothing for an example whose application a generator creates in an empty directory. */
  readonly repository: Repository | undefined;
  readonly example: Example | undefined;
};

function Playground({ repository, example }: PlaygroundProps) {
  const session = useRepositorySession(repository);
  const title = repository && `${repository.owner}/${repository.name}`;

  return (
    <div className="app">
      <header className="topbar">
        <SiteMark />
        {repository ? (
          <>
            <a className="repository-link" href={`https://github.com/${title}`} target="_blank" rel="noreferrer">
              {title}
            </a>
            {repository.ref !== 'HEAD' && <span className="repository-ref">{repository.ref}</span>}
            {example?.dir && <span className="repository-ref">{example.dir}</span>}
          </>
        ) : (
          example && <span className="example-name">{example.title}</span>
        )}
        {example?.partly && <PartlyBadge reason={example.partly} />}
        <RepositoryInput />
      </header>
      {session.phase === 'ready' ? (
        <Workspace
          container={session.container}
          label={repository?.name ?? example?.id ?? 'demo'}
          example={example}
        />
      ) : (
        <p className="session-status" role="status" data-phase={session.phase}>
          {session.phase === 'loading' ? session.step : session.message}
        </p>
      )}
    </div>
  );
}

type WorkspaceProps = {
  readonly container: Mimic;
  /** The name the terminal prompt shows for the working directory. */
  readonly label: string;
  readonly example: Example | undefined;
};

/** Where the terminals start, and what the first one has typed. */
type TerminalStart = { readonly cwd: string; readonly line?: string };

function Workspace({ container, label, example }: WorkspaceProps) {
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [terminalStart, setTerminalStart] = useState<TerminalStart>();
  const filesVersion = useFilesVersion(container);
  const endpoints = usePublishedEndpoints(container);

  const openFile = useCallback((path: string) => {
    setTabs((current) => (current.includes(path) ? current : [...current, path]));
    setActivePath(path);
  }, []);

  const closeTab = (path: string) => {
    const index = tabs.indexOf(path);
    const remaining = tabs.filter((tab) => tab !== path);
    setTabs(remaining);
    if (path === activePath) setActivePath(remaining[Math.min(index, remaining.length - 1)]);
  };

  useEffect(() => {
    void (async () => {
      // An example starts in its application's directory, if the repository still has it.
      const directory = example?.dir && `${container.workdir}/${example.dir}`;
      const found = !directory || (await container.fs.exists(directory));
      const home = directory && found ? directory : container.workdir;
      setTerminalStart({ cwd: home, line: found ? example?.command : undefined });
      const readme = (await findReadme(container, home)) ?? (await findReadme(container, container.workdir));
      if (readme) openFile(readme);
    })();
  }, [container, example, openFile]);

  return (
    <main className="workspace" data-preview={endpoints.length > 0 || undefined}>
      <nav className="sidebar" aria-label="Files">
        <FileTree
          container={container}
          filesVersion={filesVersion.value}
          activePath={activePath}
          onOpen={openFile}
        />
      </nav>
      <EditorPane
        container={container}
        filesVersion={filesVersion.value}
        tabs={tabs}
        activePath={activePath}
        onSelect={setActivePath}
        onClose={closeTab}
      />
      {terminalStart ? (
        <Terminals
          container={container}
          label={label}
          cwd={terminalStart.cwd}
          initialLine={terminalStart.line}
          onCommandFinished={() => void filesVersion.refresh()}
        />
      ) : (
        <section className="terminals" aria-label="Terminal" />
      )}
      <Preview endpoints={endpoints} />
    </main>
  );
}

async function findReadme(container: Mimic, directory: string): Promise<string | undefined> {
  const names = await container.fs.readdir(directory);
  const readme = names.find((name) => typeof name === 'string' && /^readme\.md$/i.test(name));
  return typeof readme === 'string' ? `${directory}/${readme}` : undefined;
}

// A second hostname of this deployment that serves the preview documents, or
// a wildcard of them (the package README's "Running the container on a
// preview origin"); the page's own origin when none is configured.
const boot = () => Mimic.boot({ previewOrigin: import.meta.env.VITE_PREVIEW_ORIGIN || undefined });

// A page hosts one container at a time: a session boots once the previous one is torn down.
let previousSession: Promise<void> = Promise.resolve();

/**
 * Boots a container that holds the repository's files in its working
 * directory, or an empty working directory without a repository.
 */
function useRepositorySession(repository: Repository | undefined): Session {
  const [session, setSession] = useState<Session>({ phase: 'loading', step: 'Starting…' });

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    let container: Mimic | undefined;

    const start = async () => {
      if (signal.aborted) return;
      if (!repository) {
        container = await boot();
        if (!signal.aborted) setSession({ phase: 'ready', container });
        return;
      }
      const title = `${repository.owner}/${repository.name}`;
      setSession({ phase: 'loading', step: `Downloading ${title}…` });
      const download = downloadRepository(
        repository,
        (progress) => {
          if (!signal.aborted) setSession({ phase: 'loading', step: `Downloading ${title}… ${progress}` });
        },
        signal
      );
      // Awaited after the boot; a failure in between must not go unhandled.
      download.catch(() => undefined);
      container = await boot();
      const tree = await download;
      if (signal.aborted) return;
      setSession({ phase: 'loading', step: `Mounting ${title}…` });
      await container.fs.mount(tree);
      if (!signal.aborted) setSession({ phase: 'ready', container });
    };

    const started = previousSession.then(start).catch((error: unknown) => {
      if (!signal.aborted) {
        setSession({ phase: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    });
    return () => {
      abort.abort();
      previousSession = started.then(() => container?.teardown()).catch(() => undefined);
    };
  }, [repository]);

  return session;
}

/**
 * A number that changes whenever the container's files may have changed.
 * Programs change files without the page hearing of it, so the revision of the
 * file system is read on an interval.
 */
function useFilesVersion(container: Mimic): { readonly value: number; readonly refresh: () => Promise<void> } {
  const [value, setValue] = useState(0);

  const refresh = useCallback(async () => {
    try {
      // Any read reports the current revision.
      await container.fs.exists(container.workdir);
      setValue(container.fs.revision);
    } catch {
      // The container is being torn down.
    }
  }, [container]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), FILES_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { value, refresh };
}
