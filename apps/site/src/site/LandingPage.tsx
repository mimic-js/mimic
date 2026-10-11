import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { StackIcon } from './StackIcon';
import { exampleTitle, playgroundStacks, tooling } from './stacks';
import { highlight } from './highlight';

const INSTALL = 'npm install @mimic-js/runtime';

const QUICK_START = `import { Mimic } from '@mimic-js/runtime';

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
    body: 'Each process is a Web Worker. All of them share one in-memory, POSIX-like file system.'
  },
  {
    title: 'Real package managers',
    body: 'npm, pnpm and Yarn are the upstream CLIs, installing real packages from the npm registry.'
  },
  {
    title: 'Ports become URLs',
    body: 'A server a program starts becomes a URL for an iframe, with streaming HTTP and WebSockets.'
  },
  {
    title: 'WASI for native tooling',
    body: 'Tools with native code, such as esbuild and Rollup, run from their publishers’ WebAssembly builds.'
  },
  {
    title: 'A POSIX shell subset',
    body: 'sh -c runs package scripts: pipes, redirection, &&, globs and control flow.'
  },
  {
    title: 'Node 22 on linux',
    body: 'Programs see Node 22 on linux, so packages take the code paths they already have.'
  }
];

type Comparison = {
  readonly aspect: string;
  readonly cloud: string;
  readonly webcontainers: string;
  readonly mimic: string;
};

/** Three ways to run a user's Node.js project from a web app (the root README's table). */
const COMPARISON: readonly Comparison[] = [
  {
    aspect: 'Licence',
    cloud: 'A hosted service’s terms, or infrastructure you run',
    webcontainers: 'The vendor’s licence and terms',
    mimic: 'MIT: self-hosted, no API key, no usage limits'
  },
  {
    aspect: 'Where the project runs',
    cloud: 'A remote machine per user',
    webcontainers: 'The user’s tab; the runtime served by the vendor',
    mimic: 'The user’s tab; the runtime served from your origin'
  },
  {
    aspect: 'Startup',
    cloud: 'Provision or wake a machine',
    webcontainers: 'No machine; installs use the user’s CPU',
    mimic: 'No machine; installs use the user’s CPU'
  },
  {
    aspect: 'Server cost per user',
    cloud: 'A machine per active user',
    webcontainers: 'None beyond hosting the page',
    mimic: 'None beyond hosting the page'
  },
  {
    aspect: 'Isolation',
    cloud: 'A VM or container',
    webcontainers: 'The browser’s sandbox',
    mimic: 'A cross-origin-isolated tab, optionally a separate preview origin'
  },
  {
    aspect: 'Limits',
    cloud: 'Anything Linux runs, Docker included',
    webcontainers: 'No native binaries or Docker; a tab’s memory',
    mimic: 'No native binaries or Docker; a tab’s memory'
  }
];

const SHOWCASE_EXAMPLE = 'phaser-vite';

export function LandingPage() {
  // A link to a section of the landing page, such as /#how-it-compares, scrolls to it.
  const { hash } = useLocation();
  useEffect(() => {
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target) target.scrollIntoView();
  }, [hash]);

  return (
    <main className="site-main landing-page">
      <section className="hero">
        <img className="hero-wordmark" src="/mimic-wordmark-dark.svg" alt="Mimic" width={330} height={120} />
        <h1 className="hero-title">
          A dev container.
          <br />
          In your tab.
        </h1>
        <p className="hero-lede">
          Node.js, npm and your dev server, in the browser. No Docker, no cloud VM. Open source, MIT, self-hosted.
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

      <figure className="hero-shot">
        <Link to={`/playground?${new URLSearchParams({ example: SHOWCASE_EXAMPLE })}`} title={exampleTitle(SHOWCASE_EXAMPLE)}>
          <img
            src="/playground.png"
            width={1440}
            height={900}
            alt="The playground: a file tree, an editor with the project’s source, a terminal that ran npm install and npm run dev, and the dev server’s page in a preview"
          />
        </Link>
        <figcaption>
          The playground with Phaser’s Vite template: the repository’s files, a terminal where <code>npm install</code> and{' '}
          <code>npm run dev</code> ran, and the dev server’s page in the preview. Everything in the tab.
        </figcaption>
      </figure>

      <section className="landing-section" aria-labelledby="what-it-is">
        <h2 id="what-it-is">What it is</h2>
        <p className="section-lede section-lede-wide">
          Mimic is a browser-based runtime that executes Node.js applications and shell commands entirely inside a
          browser tab. Workloads that used to need a cloud VM per user, such as installing packages, running a dev
          server or executing user code, run client-side instead, on the user’s CPU, with nothing to provision and
          nothing leaving the browser but package downloads and the project’s own requests. Mimic is open source under
          the MIT licence and served from your own origin: no vendor service, no API key, no usage limits.
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
                        <StackIcon icon={stack.icon} label={stack.label} />
                        {stack.label}
                      </Link>
                    ) : (
                      <span className="chip">
                        <StackIcon icon={stack.icon} label={stack.label} />
                        {stack.label}
                      </span>
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
                <li key={tool.label}>
                  <span className="chip chip-static">
                    <StackIcon icon={tool.icon} label={tool.label} />
                    {tool.label}
                  </span>
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

      <section className="landing-section" aria-labelledby="how-it-compares">
        <h2 id="how-it-compares">How it compares</h2>
        <p className="section-lede">Three ways to run a user’s Node.js project from a web app.</p>
        <div className="compare-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Aspect</span>
                </th>
                <th scope="col">Cloud VM or container</th>
                <th scope="col">WebContainers</th>
                <th scope="col" className="compare-mimic">
                  Mimic
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.aspect}>
                  <th scope="row">{row.aspect}</th>
                  <td>{row.cloud}</td>
                  <td>{row.webcontainers}</td>
                  <td className="compare-mimic">{row.mimic}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="section-lede">
          The <Link to="/docs/faq">FAQ</Link> covers what leaves the browser, networking and running code you did not
          write.
        </p>
      </section>

      <section className="landing-section" aria-labelledby="quick-start">
        <h2 id="quick-start">Quick start</h2>
        <pre className="code-block">
          <code dangerouslySetInnerHTML={{ __html: highlight(INSTALL, 'sh') }} />
        </pre>
        <pre className="code-block">
          <code dangerouslySetInnerHTML={{ __html: highlight(QUICK_START, 'ts') }} />
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
