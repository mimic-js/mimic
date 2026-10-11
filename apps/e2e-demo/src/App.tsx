import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import reactPackageLock from '../../../packages/runtime/compatibility/fixtures/react-18-vite-6.4.3/package-lock.json'
import reactPackage from '../../../packages/runtime/compatibility/fixtures/react-18-vite-6.4.3/package.json'
import solidPackageLock from './demo-fixtures/solid/package-lock.json'
import solidPackage from './demo-fixtures/solid/package.json'
import sveltePackageLock from '../../../packages/runtime/compatibility/fixtures/svelte-5-vite-6.4.3/package-lock.json'
import sveltePackage from '../../../packages/runtime/compatibility/fixtures/svelte-5-vite-6.4.3/package.json'
import typescriptPackageLock from '../../../packages/runtime/compatibility/fixtures/typescript-vite-6.4.3/package-lock.json'
import typescriptPackage from '../../../packages/runtime/compatibility/fixtures/typescript-vite-6.4.3/package.json'
import vanillaVite6PackageLock from '../../../packages/runtime/compatibility/fixtures/vanilla-vite-6.4.3/package-lock.json'
import vanillaVite6Package from '../../../packages/runtime/compatibility/fixtures/vanilla-vite-6.4.3/package.json'
import vanillaVite7PackageLock from '../../../packages/runtime/compatibility/fixtures/vanilla-vite-7.3.6/package-lock.json'
import vanillaVite7Package from '../../../packages/runtime/compatibility/fixtures/vanilla-vite-7.3.6/package.json'
import vuePackageLock from '../../../packages/runtime/compatibility/fixtures/vue-3-vite-6.4.3/package-lock.json'
import vuePackage from '../../../packages/runtime/compatibility/fixtures/vue-3-vite-6.4.3/package.json'
import { Mimic } from '@mimic-js/runtime'
import type { MimicProcess, FileSystemTree } from '@mimic-js/runtime'

const decoder = new TextDecoder()

const initialApp = `export function renderApp(target) {
  target.innerHTML = \`
    <main class="demo-shell">
      <section class="hero">
        <p class="eyebrow">Mimic</p>
        <h1>Vite preview is running inside the browser.</h1>
        <p class="copy">This project was mounted into a virtual file system and served by real Vite middleware.</p>
      </section>
      <section class="metric-row">
        <article><span>Runtime</span><strong>browser</strong></article>
        <article><span>Server</span><strong>Vite middleware</strong></article>
        <article><span>Preview</span><strong>Service Worker</strong></article>
      </section>
    </main>
  \`;
}

if (import.meta.hot) {
  import.meta.hot.accept((module) => {
    module?.renderApp(document.getElementById('root'));
  });
}`

const typescriptApp = `type DemoMetric = {
  label: string;
  value: string;
};

const metrics: DemoMetric[] = [
  { label: 'Runtime', value: 'browser' },
  { label: 'Transform', value: 'TypeScript' },
  { label: 'Server', value: 'Vite middleware' },
];

export function renderApp(target: HTMLElement) {
  target.innerHTML = \`
    <main class="demo-shell">
      <section class="hero">
        <p class="eyebrow">Mimic</p>
        <h1>TypeScript + Vite preview is running inside the browser.</h1>
        <p class="copy">Typed source was transformed by real Vite middleware inside the browser runtime.</p>
      </section>
      <section class="metric-row">
        \${metrics.map((metric) => \`<article><span>\${metric.label}</span><strong>\${metric.value}</strong></article>\`).join('')}
      </section>
    </main>
  \`;
}

if (import.meta.hot) {
  import.meta.hot.accept((module) => {
    module?.renderApp(document.getElementById('root') as HTMLElement);
  });
}`

const reactApp = `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="demo-shell">
      <section className="hero">
        <p className="eyebrow">Mimic</p>
        <h1>React + Vite preview is running inside the browser.</h1>
        <p className="copy">This project was mounted into a virtual file system and served by real Vite middleware.</p>
      </section>
      <section className="metric-row">
        <article><span>Runtime</span><strong>browser</strong></article>
        <article><span>Plugin</span><strong>React</strong></article>
        <article>
          <span>Fast Refresh state</span>
          <strong data-refresh-count>{count}</strong>
          <button type="button" onClick={() => setCount((value) => value + 1)}>Increment</button>
        </article>
      </section>
    </main>
  );
}`

const vueApp = `<template>
  <main class="demo-shell">
    <section class="hero">
      <p class="eyebrow">Mimic</p>
      <h1>Vue + Vite preview is running inside the browser.</h1>
      <p class="copy">This project was mounted into a virtual file system and served by real Vite middleware.</p>
    </section>
    <section class="metric-row">
      <article><span>Runtime</span><strong>browser</strong></article>
      <article><span>Plugin</span><strong>Vue</strong></article>
      <article><span>Preview</span><strong>Service Worker</strong></article>
    </section>
  </main>
</template>`

const solidApp = `export default function App() {
  return (
    <main class="demo-shell">
      <section class="hero">
        <p class="eyebrow">Mimic</p>
        <h1>Solid + Vite preview is running inside the browser.</h1>
        <p class="copy">This project was mounted into a virtual file system and served by real Vite middleware.</p>
      </section>
      <section class="metric-row">
        <article><span>Runtime</span><strong>browser</strong></article>
        <article><span>Plugin</span><strong>Solid</strong></article>
        <article><span>Preview</span><strong>Service Worker</strong></article>
      </section>
    </main>
  );
}`

const svelteApp = `<script>
  let count = 0;
</script>

<main class="demo-shell">
  <section class="hero">
    <p class="eyebrow">Mimic</p>
    <h1>Svelte + Vite preview is running inside the browser.</h1>
    <p class="copy">This project was mounted into a virtual file system and served by real Vite middleware.</p>
  </section>
  <section class="metric-row">
    <article><span>Runtime</span><strong>browser</strong></article>
    <article><span>Plugin</span><strong>Svelte</strong></article>
    <article><span>Updates</span><strong>{count}</strong><button type="button" on:click={() => count += 1}>Increment</button></article>
  </section>
</main>`

type DemoFixture = {
    label: string
    support: 'partial' | 'experimental'
    supportLabel: string
    appPath: string
    appSource: string
    stylePath: string
    styleSource: string
    installArgs?: readonly string[]
    projectTree: FileSystemTree
}

type EditableFile = 'app' | 'style'

const demoCss = `:root {
  color: #f7f1df;
  background: #171717;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.demo-shell {
  min-height: 100vh;
  display: grid;
  align-content: center;
  gap: 28px;
  padding: 48px;
  background:
    radial-gradient(circle at 18% 18%, rgba(235, 95, 67, 0.24), transparent 24rem),
    linear-gradient(135deg, #171717 0%, #1f2a2a 55%, #153739 100%);
}

.hero {
  max-width: 760px;
}

.eyebrow {
  margin: 0 0 14px;
  color: #8bd3c7;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  max-width: 720px;
  font-size: 56px;
  line-height: 1;
  letter-spacing: 0;
}

.copy {
  max-width: 620px;
  margin: 22px 0 0;
  color: #d8cfb6;
  font-size: 18px;
  line-height: 1.6;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 180px));
  gap: 12px;
}

article {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}

article span {
  color: #a8b2ad;
  font-size: 13px;
}

article strong {
  color: white;
  font-size: 20px;
}

@media (max-width: 720px) {
  .demo-shell {
    padding: 28px;
  }

  h1 {
    font-size: 36px;
  }

  .metric-row {
    grid-template-columns: 1fr;
  }
}`

const vanillaFixture: DemoFixture = {
    label: 'Vanilla',
    support: 'partial',
    supportLabel: 'Browser-proven partial',
    appPath: '/home/project/src/App.js',
    appSource: initialApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(vanillaVite6Package, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(vanillaVite6PackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `export default {
  plugins: [{
    name: 'mimic-hmr-probe',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url || '/', 'http://mimic.local');
        if (url.pathname !== '/__mimic_hmr_probe') {
          next();
          return;
        }

        const type = url.searchParams.get('type');
        const timestamp = Date.now();
        const payloads = {
          update: {
            type: 'update',
            updates: [{
              type: 'js-update',
              path: '/src/App.js',
              acceptedPath: '/src/App.js',
              timestamp,
              explicitImportRequired: false,
              isWithinCircularImport: false,
            }],
          },
          error: {
            type: 'error',
            err: {
              message: 'mimic server-originated error payload',
              stack: 'Error: mimic server-originated error payload',
            },
          },
          prune: {
            type: 'prune',
            paths: ['/src/removed-by-server.js'],
          },
          'full-reload': {
            type: 'full-reload',
            path: '/index.html',
          },
        };

        const payload = payloads[type];
        if (!payload) {
          response.statusCode = 400;
          response.end('unknown hmr probe type');
          return;
        }

        server.hot.send(payload);
        response.statusCode = 200;
        response.end('ok');
      });
    },
  }],
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.js': {
                    file: {
                        contents: `import pc from 'picocolors';
import { renderApp } from './App.js';
import './style.css';

console.log(pc.green('optimized dependency loaded'));
renderApp(document.getElementById('root'));`,
                    },
                },
                'App.js': {
                    file: {
                        contents: initialApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

const vanillaVite7Fixture: DemoFixture = {
    ...vanillaFixture,
    label: 'Vanilla Vite 7',
    projectTree: {
        ...vanillaFixture.projectTree,
        'package.json': {
            file: {
                contents: JSON.stringify(vanillaVite7Package, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(vanillaVite7PackageLock),
            },
        },
    },
}

const typescriptFixture: DemoFixture = {
    label: 'TypeScript',
    support: 'partial',
    supportLabel: 'Browser-proven partial',
    appPath: '/home/project/src/App.ts',
    appSource: typescriptApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(typescriptPackage, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(typescriptPackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted TypeScript Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `export default {
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.ts': {
                    file: {
                        contents: `import pc from 'picocolors';
import { renderApp } from './App';
import './style.css';

console.log(pc.green('optimized dependency loaded'));
renderApp(document.getElementById('root') as HTMLElement);`,
                    },
                },
                'App.ts': {
                    file: {
                        contents: typescriptApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

const reactFixture: DemoFixture = {
    label: 'React',
    support: 'partial',
    supportLabel: 'First framework target',
    appPath: '/home/project/src/App.jsx',
    appSource: reactApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(reactPackage, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(reactPackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted React Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `import react from '@vitejs/plugin-react';

export default {
  plugins: [react()],
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.jsx': {
                    file: {
                        contents: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';

createRoot(document.getElementById('root')).render(React.createElement(App));`,
                    },
                },
                'App.jsx': {
                    file: {
                        contents: reactApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

const vueFixture: DemoFixture = {
    label: 'Vue',
    support: 'partial',
    supportLabel: 'Browser-proven partial',
    appPath: '/home/project/src/App.vue',
    appSource: vueApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(vuePackage, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(vuePackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted Vue Vite App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `import vue from '@vitejs/plugin-vue';

export default {
  plugins: [vue()],
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.js': {
                    file: {
                        contents: `import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');`,
                    },
                },
                'App.vue': {
                    file: {
                        contents: vueApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

const solidFixture: DemoFixture = {
    label: 'Solid',
    support: 'partial',
    supportLabel: 'Browser-proven partial',
    appPath: '/home/project/src/App.jsx',
    appSource: solidApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(solidPackage, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(solidPackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted Solid Vite App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `import solid from 'vite-plugin-solid';

export default {
  plugins: [solid()],
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.jsx': {
                    file: {
                        contents: `import { render } from 'solid-js/web';
import App from './App.jsx';
import './style.css';

render(() => <App />, document.getElementById('root'));`,
                    },
                },
                'App.jsx': {
                    file: {
                        contents: solidApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

const svelteFixture: DemoFixture = {
    label: 'Svelte',
    support: 'experimental',
    supportLabel: 'Experimental browser proof',
    appPath: '/home/project/src/App.svelte',
    appSource: svelteApp,
    stylePath: '/home/project/src/style.css',
    styleSource: demoCss,
    installArgs: ['ci'],
    projectTree: {
        'package.json': {
            file: {
                contents: JSON.stringify(sveltePackage, null, 2),
            },
        },
        'package-lock.json': {
            file: {
                contents: JSON.stringify(sveltePackageLock),
            },
        },
        'index.html': {
            file: {
                contents: `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mounted Svelte Vite App</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`,
            },
        },
        'vite.config.js': {
            file: {
                contents: `import { svelte } from '@sveltejs/vite-plugin-svelte';

export default {
  plugins: [svelte()],
  optimizeDeps: {
    entries: ['index.html'],
  },
};
`,
            },
        },
        src: {
            directory: {
                'main.js': {
                    file: {
                        contents: `import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';

mount(App, { target: document.getElementById('app') });`,
                    },
                },
                'App.svelte': {
                    file: {
                        contents: svelteApp,
                    },
                },
                'style.css': {
                    file: {
                        contents: demoCss,
                    },
                },
            },
        },
    },
}

type FixtureName = 'vanilla' | 'vanilla-vite7' | 'typescript' | 'react' | 'vue' | 'solid' | 'svelte'

const fixtures: Record<FixtureName, DemoFixture> = {
    vanilla: vanillaFixture,
    'vanilla-vite7': vanillaVite7Fixture,
    typescript: typescriptFixture,
    react: reactFixture,
    vue: vueFixture,
    solid: solidFixture,
    svelte: svelteFixture,
}

const fixtureEntries = Object.entries(fixtures) as Array<[FixtureName, DemoFixture]>
type RuntimeStatus = 'idle' | 'booting' | 'installing' | 'starting' | 'ready' | 'failed'
const busyStatuses = new Set<RuntimeStatus>(['booting', 'installing', 'starting'])

function fixtureNameFromLocation(): FixtureName {
    const selected = new URLSearchParams(window.location.search).get('fixture')
    return selected && selected in fixtures ? (selected as FixtureName) : 'vanilla'
}

export function App() {
    const [fixtureName, setFixtureName] = useState<FixtureName>(fixtureNameFromLocation)
    const fixture = fixtures[fixtureName]
    const [container, setContainer] = useState<Mimic | null>(null)
    const [terminal, setTerminal] = useState('')
    const [previewUrl, setPreviewUrl] = useState('')
    const [editableFile, setEditableFile] = useState<EditableFile>('app')
    const [appSource, setAppSource] = useState(fixture.appSource)
    const [styleSource, setStyleSource] = useState(fixture.styleSource)
    const [status, setStatus] = useState<RuntimeStatus>('idle')
    const [isSaving, setIsSaving] = useState(false)
    const processRef = useRef<MimicProcess | null>(null)
    const containerRef = useRef<Mimic | null>(null)
    const runSequenceRef = useRef(0)
    const editorRef = useRef<HTMLTextAreaElement | null>(null)

    const appendTerminal = useCallback((chunk: string) => {
        setTerminal((current) => `${current}${chunk}`)
    }, [])

    const pipeProcess = useCallback(
        async (process: MimicProcess) => {
            const reader = process.output.getReader()
            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    appendTerminal(decoder.decode(value))
                }
            } finally {
                reader.releaseLock()
            }
        },
        [appendTerminal],
    )

    const runDemo = useCallback(async () => {
        const runSequence = ++runSequenceRef.current
        processRef.current?.kill('SIGTERM')
        const previousRuntime = containerRef.current
        processRef.current = null
        containerRef.current = null
        await previousRuntime?.teardown()

        setContainer(null)
        setStatus('booting')
        setTerminal('')
        setPreviewUrl('')

        try {
            const runtime = await Mimic.boot({ workdir: '/home/project' })
            if (runSequence !== runSequenceRef.current) {
                await runtime.teardown()
                return
            }
            setContainer(runtime)
            containerRef.current = runtime
            runtime.endpoints.on('published', ({ address, url }) => {
                if (runSequence !== runSequenceRef.current) return
                appendTerminal(`port open: ${address.port} ${url}\n`)
                setPreviewUrl(url)
                setStatus('ready')
            })
            runtime.endpoints.on('unpublished', ({ address, url }) => {
                if (runSequence !== runSequenceRef.current) return
                appendTerminal(`port close: ${address.port} ${url}\n`)
                setPreviewUrl((current) => current === url ? '' : current)
            })

            await runtime.fs.mount(fixture.projectTree)
            if (runSequence !== runSequenceRef.current) {
                await runtime.teardown()
                return
            }
            setStatus('installing')
            const install = await runtime.spawn('npm', [...(fixture.installArgs ?? ['install'])])
            processRef.current = install
            await pipeProcess(install)
            const installCode = await install.exit
            if (runSequence !== runSequenceRef.current) {
                await runtime.teardown()
                return
            }
            processRef.current = null
            appendTerminal(`install exited with ${installCode}\n\n`)

            if (installCode !== 0) {
                setStatus('failed')
                return
            }

            setStatus('starting')
            const dev = await runtime.spawn('npm', ['run', 'dev'])
            processRef.current = dev
            void pipeProcess(dev)
            void dev.exit.then((code) => {
                if (code !== 0 && processRef.current === dev) setStatus('failed')
            })
        } catch (error) {
            if (runSequence !== runSequenceRef.current) return
            setStatus('failed')
            appendTerminal(
                error instanceof Error
                    ? `${error.stack ?? error.message}\n`
                    : `${String(error)}\n`,
            )
        }
    }, [appendTerminal, fixture.projectTree, pipeProcess])

    useEffect(() => {
        let cancelled = false
        const startTimer = window.setTimeout(() => {
            if (!cancelled) void runDemo()
        }, 0)
        return () => {
            cancelled = true
            window.clearTimeout(startTimer)
            runSequenceRef.current += 1
            processRef.current?.kill('SIGTERM')
            void containerRef.current?.teardown()
        }
    }, [runDemo])

    const selectFixture = useCallback(
        (nextFixtureName: FixtureName) => {
            if (nextFixtureName === fixtureName) return
            const nextFixture = fixtures[nextFixtureName]
            setFixtureName(nextFixtureName)
            setEditableFile('app')
            setAppSource(nextFixture.appSource)
            setStyleSource(nextFixture.styleSource)
            const url = new URL(window.location.href)
            if (nextFixtureName === 'vanilla') url.searchParams.delete('fixture')
            else url.searchParams.set('fixture', nextFixtureName)
            window.history.replaceState(null, '', url)
        },
        [fixtureName],
    )

    const saveFile = useCallback(async () => {
        if (!container) return
        const source = editorRef.current?.value ?? (editableFile === 'app' ? appSource : styleSource)
        const path = editableFile === 'app' ? fixture.appPath : fixture.stylePath
        setIsSaving(true)
        try {
            await container.fs.writeFile(path, source)
        } finally {
            window.setTimeout(() => setIsSaving(false), 220)
        }
    }, [appSource, container, editableFile, fixture.appPath, fixture.stylePath, styleSource])

    const activeEditorPath = editableFile === 'app' ? fixture.appPath : fixture.stylePath
    const activeEditorSource = editableFile === 'app' ? appSource : styleSource

    const statusLabel = useMemo(() => {
        if (status === 'booting') return 'booting'
        if (status === 'installing') return 'installing'
        if (status === 'starting') return 'starting server'
        if (status === 'ready') return 'ready'
        if (status === 'failed') return 'failed'
        return 'idle'
    }, [status])
    const fixtureSupportLabel = `${fixture.label}: ${fixture.supportLabel}`
    const isBusy = busyStatuses.has(status)

    return (
        <div className="app">
            <header className="topbar">
                <div>
                    <p className="kicker">Mimic</p>
                    <h1>MVP runtime</h1>
                </div>
                <div className="topbar-controls">
                    <label className="fixture-picker">
                        <span>Fixture</span>
                        <select
                            aria-label="Fixture"
                            value={fixtureName}
                            onChange={(event) => selectFixture(event.target.value as FixtureName)}
                            disabled={isBusy}
                        >
                            {fixtureEntries.map(([name, option]) => (
                                <option key={name} value={name}>
                                    {option.label} - {option.supportLabel}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className="fixture-support" data-support={fixture.support}>
                        {fixtureSupportLabel}
                    </div>
                    <div className="status" data-state={status}>
                        <span />
                        {statusLabel}
                    </div>
                </div>
            </header>

            <main className="workspace">
                <section
                    className="panel editor-panel"
                    aria-label="Mounted file editor"
                >
                    <div className="panel-head">
                        <div>
                            <span className="panel-label">{activeEditorPath}</span>
                            <strong>Mounted source</strong>
                        </div>
                        <div className="editor-actions">
                            <div className="file-tabs" role="tablist" aria-label="Editable mounted files">
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={editableFile === 'app'}
                                    onClick={() => setEditableFile('app')}
                                >
                                    App
                                </button>
                                <button
                                    type="button"
                                    role="tab"
                                    aria-selected={editableFile === 'style'}
                                    onClick={() => setEditableFile('style')}
                                >
                                    CSS
                                </button>
                            </div>
                            <button
                                className="write-button"
                                type="button"
                                onClick={saveFile}
                                disabled={!container || isSaving}
                            >
                                {isSaving ? 'Saved' : 'Write'}
                            </button>
                        </div>
                    </div>
                    <textarea
                        key={`${fixtureName}:${editableFile}`}
                        ref={editorRef}
                        spellCheck={false}
                        defaultValue={activeEditorSource}
                        onChange={(event) => {
                            if (editableFile === 'app') setAppSource(event.target.value)
                            else setStyleSource(event.target.value)
                        }}
                    />
                </section>

                <section
                    className="panel preview-panel"
                    aria-label="Preview iframe"
                >
                    <div className="panel-head">
                        <div>
                            <span className="panel-label">iframe</span>
                            <strong>Virtual Vite-compatible preview</strong>
                        </div>
                        <button type="button" onClick={runDemo}>
                            Restart
                        </button>
                    </div>
                    <div className="browser-frame">
                        <div className="browser-bar">
                            <span />
                            <code>
                                {previewUrl || 'waiting for published endpoint'}
                            </code>
                        </div>
                        {previewUrl ? (
                            <iframe
                                title="Mimic preview"
                                src={previewUrl}
                            />
                        ) : (
                            <div className="empty-preview" />
                        )}
                    </div>
                </section>

                <section
                    className="panel terminal-panel"
                    aria-label="Runtime terminal"
                >
                    <div className="panel-head">
                        <div>
                            <span className="panel-label">process output</span>
                            <strong>Terminal</strong>
                        </div>
                    </div>
                    <pre>{terminal}</pre>
                </section>
            </main>
        </div>
    )
}
