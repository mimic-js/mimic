import type { Repository } from './github-archive';

/** A repository of the demo pool that started in development mode and rendered its own page. */
export type Example = {
  readonly id: string;
  readonly stack: string;
  readonly title: string;
  /** Nothing for an application a generator creates in an empty directory. */
  readonly repository?: Repository;
  /** The application's directory inside the repository; the terminal starts there. */
  readonly dir?: string;
  /** Typed into the first terminal, not run: the user presses Enter. */
  readonly command: string;
  /** The application is created by a generator in an empty directory. */
  readonly generated?: boolean;
  /** What does not work yet, for an example that only partly works. */
  readonly partly?: string;
};

type ExampleSource = Omit<Example, 'repository' | 'command'> & {
  readonly repo?: string;
  readonly ref?: string;
  readonly command?: string;
};

const NPM_DEV = 'npm install && npm run dev';
const NPM_START = 'npm install && npm start';

// Official generators run in an empty working directory.
const generate = (example: Omit<ExampleSource, 'repo'> & { readonly command: string }): ExampleSource => ({
  ...example,
  generated: true
});

// A part of the passes of docs/research/2026-10-09-demo-app-pool.md; the
// demo pool (demo-pool/build-pool.mjs) holds the full list and its runner.
const sources: readonly ExampleSource[] = [
  { id: 'vite8-react-ts', stack: 'Vite', title: 'React + TypeScript (create-vite 8)', repo: 'vitejs/vite', ref: 'v8.3.4', dir: 'packages/create-vite/template-react-ts' },
  { id: 'vite8-vue-ts', stack: 'Vite', title: 'Vue + TypeScript (create-vite 8)', repo: 'vitejs/vite', ref: 'v8.3.4', dir: 'packages/create-vite/template-vue-ts' },
  { id: 'vite8-svelte-ts', stack: 'Vite', title: 'Svelte + TypeScript (create-vite 8)', repo: 'vitejs/vite', ref: 'v8.3.4', dir: 'packages/create-vite/template-svelte-ts' },
  { id: 'vite8-solid-ts', stack: 'Vite', title: 'Solid + TypeScript (create-vite 8)', repo: 'vitejs/vite', ref: 'v8.3.4', dir: 'packages/create-vite/template-solid-ts' },
  { id: 'vite8-vanilla-ts', stack: 'Vite', title: 'Vanilla TypeScript (create-vite 8)', repo: 'vitejs/vite', ref: 'v8.3.4', dir: 'packages/create-vite/template-vanilla-ts' },
  { id: 'vite7-lit-ts', stack: 'Vite', title: 'Lit + TypeScript (create-vite 7)', repo: 'vitejs/vite', ref: 'v7.3.7', dir: 'packages/create-vite/template-lit-ts' },
  { id: 'vite5-preact-ts', stack: 'Vite', title: 'Preact + TypeScript (create-vite 5)', repo: 'vitejs/vite', ref: 'v5.4.21', dir: 'packages/create-vite/template-preact-ts' },
  { id: 'phaser-vite', stack: 'Vite', title: 'Phaser 4 Vite template', repo: 'phaserjs/template-vite' },

  generate({ id: 'angular16-ng-new', stack: 'Angular', title: 'ng new (Angular CLI 16)', command: 'npx -y @angular/cli@16 new demo --defaults --skip-git --skip-install --skip-tests && cd demo && npm install && npm start' }),
  // Its router needs the preview at the root of its own origin (ADR-0044), which the development default provides.
  generate({ id: 'angular21-ng-new', stack: 'Angular', title: 'ng new (Angular CLI 21)', command: 'npx -y @angular/cli@21 new demo --defaults --skip-git --skip-install --skip-tests && cd demo && npm install && npm start' }),
  { id: 'todomvc-angular', stack: 'Angular', title: 'TodoMVC Angular', repo: 'tastejs/todomvc', dir: 'examples/angular', command: NPM_START },

  { id: 'redux-vite-template', stack: 'React', title: 'Redux Toolkit Vite template', repo: 'reduxjs/redux-templates', dir: 'packages/vite-template-redux' },
  { id: 'tanstack-query-basic', stack: 'React', title: 'TanStack Query basic example', repo: 'TanStack/query', dir: 'examples/react/basic' },
  { id: 'react-realworld', stack: 'React', title: 'RealWorld React/Redux (react-scripts 1)', repo: 'gothinkster/react-redux-realworld-example-app', command: NPM_START },
  { id: 'todomvc-react', stack: 'React', title: 'TodoMVC React (webpack-dev-server 5)', repo: 'tastejs/todomvc', dir: 'examples/react' },

  { id: 'todomvc-vue', stack: 'Vue', title: 'TodoMVC Vue (Vite)', repo: 'tastejs/todomvc', dir: 'examples/vue' },

  { id: 'sveltekit-realworld', stack: 'Svelte', title: 'SvelteKit RealWorld', repo: 'sveltejs/realworld', command: 'pnpm install && pnpm dev' },
  { id: 'svelte3-rollup-template', stack: 'Svelte', title: 'Svelte 3 template (Rollup)', repo: 'sveltejs/template' },
  { id: 'sapper-rollup', stack: 'Svelte', title: 'Sapper template (Rollup)', repo: 'sveltejs/sapper-template', ref: 'rollup' },
  { id: 'todomvc-svelte', stack: 'Svelte', title: 'TodoMVC Svelte 5 (Vite)', repo: 'tastejs/todomvc', dir: 'examples/svelte' },

  { id: 'solid-vite-basic', stack: 'Solid', title: 'Solid basic template (Vite)', repo: 'solidjs/templates', dir: 'vanilla/basic' },
  { id: 'solid-start2-basic', stack: 'Solid', title: 'SolidStart 2 basic', repo: 'solidjs/templates', dir: 'solid-start-v2/basic' },

  { id: 'astro-basics', stack: 'Astro', title: 'Astro basics', repo: 'withastro/astro', dir: 'examples/basics' },
  { id: 'astro-blog', stack: 'Astro', title: 'Astro blog', repo: 'withastro/astro', dir: 'examples/blog' },
  { id: 'astro-react', stack: 'Astro', title: 'Astro with React islands', repo: 'withastro/astro', dir: 'examples/framework-react' },

  { id: 'rspack-react', stack: 'Rspack', title: 'Rspack React', repo: 'rspack-contrib/rspack-examples', dir: 'rspack/react' },
  { id: 'rspack-vue', stack: 'Rspack', title: 'Rspack Vue', repo: 'rspack-contrib/rspack-examples', dir: 'rspack/vue' },
  { id: 'rsbuild-react', stack: 'Rspack', title: 'Rsbuild React', repo: 'rspack-contrib/rspack-examples', dir: 'rsbuild/react' },
  { id: 'rsbuild-vue', stack: 'Rspack', title: 'Rsbuild Vue', repo: 'rspack-contrib/rspack-examples', dir: 'rsbuild/vue' },

  generate({
    id: 'nx20-create-angular-monorepo',
    stack: 'Nx',
    title: 'create-nx-workspace 20, Angular monorepo',
    command: 'npx -y create-nx-workspace@20 demo --preset=angular-monorepo --appName=web --bundler=esbuild --style=css --e2eTestRunner=none --unitTestRunner=none --ssr=false --nxCloud=skip --packageManager=npm --interactive=false --skipGit && cd demo && npx nx serve web',
    partly: 'The Angular router needs the preview at the root of its own origin (ADR-0044): with VITE_PREVIEW_ORIGIN unset or a single origin, the welcome page shows for a moment, then the preview reloads again and again (#706).'
  }),

  { id: 'rollup-starter-app', stack: 'Other', title: 'Rollup starter app', repo: 'rollup/rollup-starter-app' },
  { id: 'eleventy-base-blog', stack: 'Other', title: 'Eleventy base blog', repo: '11ty/eleventy-base-blog', command: NPM_START },

  { id: 'nest-starter', stack: 'Node server', title: 'NestJS TypeScript starter', repo: 'nestjs/typescript-starter', command: 'npm install && npm run start' },
  { id: 'koa-hello-world', stack: 'Node server', title: 'Koa hello-world', repo: 'koajs/examples', command: 'npm install && node hello-world/app.js' },
  { id: 'hono-node', stack: 'Node server', title: 'Hono Node.js starter', repo: 'honojs/starter', dir: 'templates/nodejs' }
];

export const examples: readonly Example[] = sources.map(({ repo, ref = 'HEAD', command = NPM_DEV, ...example }) => {
  if (!repo) return { ...example, command };
  const [owner, name] = repo.split('/') as [string, string];
  return { ...example, repository: { owner, name, ref }, command };
});

/** Reads `?example=<id>`. */
export function exampleFromSearch(search: string): Example | undefined {
  const id = new URLSearchParams(search).get('example');
  return id ? examples.find((example) => example.id === id) : undefined;
}
