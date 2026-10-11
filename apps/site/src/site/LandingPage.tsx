import { Link } from 'react-router';
import { exampleTitle, playgroundStacks, tooling } from './stacks';

const INSTALL = 'npm install @mimic-js/mimic';

const QUICK_START = `import { Mimic } from '@mimic-js/mimic';

const container = await Mimic.boot();

await container.fs.mount({
  'server.mjs': {
    file: {
      contents: \`
        import http from 'node:http';
        http.createServer((request, response) => response.end('hello')).listen(3000);
      \`
    }
  }
});

container.endpoints.on('published', (endpoint) => {
  document.querySelector('iframe').src = endpoint.url;
});

const server = await container.spawn('node', ['server.mjs']);
// Later: server.kill(); await container.teardown();`;

const HOW_IT_WORKS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'Web Workers over one file system',
    body: 'Each process runs in a Web Worker. They share one in-memory, POSIX-like file system with symlinks, file descriptors and watches, which lasts as long as the container.'
  },
  {
    title: 'Real package managers',
    body: 'npm, pnpm and Yarn are the pinned upstream CLIs, run as ordinary processes. They install real packages from the npm registry; packages with native code get their publishers’ WebAssembly builds.'
  },
  {
    title: 'Ports become URLs',
    body: 'When a program listens on a port, the port is published as a URL that a page can load in an iframe or request with container.endpoints.fetch(). HTTP streams and WebSockets work.'
  },
  {
    title: 'WASI for native tooling',
    body: 'WASI Preview 1 programs run as commands and through node:wasi, so esbuild, Rspack, Rolldown, Lightning CSS and Rollup run from their publishers’ WebAssembly builds.'
  },
  {
    title: 'A POSIX shell subset',
    body: 'sh -c runs package scripts: pipes, redirection, &&, ||, $(...), globs, if, for, while and case, with PATH lookup of package bins. Here-documents and shell functions are not supported.'
  },
  {
    title: 'Node 22 on linux',
    body: 'Programs see Node 22 on linux, and process.versions.webcontainer is set, so packages take the code paths they already have for a browser-hosted Node.'
  }
];

export function LandingPage() {
  return (
    <main className="site-main landing-page">
      <section className="hero">
        <h1 className="hero-wordmark">
          <img src="/mimic-wordmark-dark.svg" alt="Mimic" width={330} height={120} />
        </h1>
        <p className="hero-lede">Node.js programs, package managers and development servers, inside a browser tab.</p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/playground">
            Open the playground
          </Link>
          <Link className="button" to="/docs/installation">
            Read the docs
          </Link>
        </div>
        <p className="experimental-note" role="note">
          <strong>Experimental.</strong> Mimic has been developed largely with AI assistance and is not recommended
          for production use before 1.0. While it is 0.x, the API may change between minor versions.
        </p>
      </section>

      <section className="landing-section" aria-labelledby="what-runs">
        <h2 id="what-runs">What runs</h2>
        <p className="section-lede">
          Stacks the playground opens. Each one starts its own development server in the tab; choose one to open it.
        </p>
        <div className="stack-groups">
          {playgroundStacks.map((group) => (
            <div key={group.title} className="stack-group">
              <h3>{group.title}</h3>
              <ul className="chips">
                {group.stacks.map((stack) => (
                  <li key={stack.label}>
                    {stack.example ? (
                      <Link
                        className="chip"
                        to={`/playground?${new URLSearchParams({ example: stack.example })}`}
                        title={exampleTitle(stack.example)}
                      >
                        {stack.label}
                      </Link>
                    ) : (
                      <span className="chip">{stack.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="stack-group">
            <h3>Tooling</h3>
            <ul className="chips">
              {tooling.map((tool) => (
                <li key={tool}>
                  <span className="chip chip-static">{tool}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="how-it-works">
        <h2 id="how-it-works">How it works</h2>
        <ul className="how-grid">
          {HOW_IT_WORKS.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="quick-start">
        <h2 id="quick-start">Quick start</h2>
        <pre className="code-block">
          <code>{INSTALL}</code>
        </pre>
        <pre className="code-block">
          <code>{QUICK_START}</code>
        </pre>
        <p className="section-lede">
          The page that calls <code>boot()</code> must be cross-origin isolated: serve it with{' '}
          <code>Cross-Origin-Opener-Policy: same-origin</code> and{' '}
          <code>Cross-Origin-Embedder-Policy: require-corp</code>. One container runs per page at a time.
        </p>
        <div className="hero-actions">
          <Link className="button button-primary" to="/playground">
            Open the playground
          </Link>
          <Link className="button" to="/docs/installation">
            Read the docs
          </Link>
        </div>
      </section>
    </main>
  );
}
