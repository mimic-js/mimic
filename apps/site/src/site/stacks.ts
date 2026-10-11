import { examples } from '../playground/examples';

/** A stack shown on the landing page; `example` opens it in the playground. */
export type Stack = { readonly label: string; readonly example?: string };

export type StackGroup = { readonly title: string; readonly stacks: readonly Stack[] };

/** What the playground opens, by group: each one is an example of `../playground/examples.ts`. */
export const playgroundStacks: readonly StackGroup[] = [
  {
    title: 'Vite',
    stacks: [
      { label: 'React', example: 'vite8-react-ts' },
      { label: 'Vue', example: 'vite8-vue-ts' },
      { label: 'Svelte', example: 'vite8-svelte-ts' },
      { label: 'Solid', example: 'vite8-solid-ts' },
      { label: 'Lit', example: 'vite7-lit-ts' },
      { label: 'Preact', example: 'vite5-preact-ts' },
      { label: 'Vanilla TypeScript', example: 'vite8-vanilla-ts' },
      { label: 'Phaser', example: 'phaser-vite' }
    ]
  },
  {
    title: 'Angular and Nx',
    stacks: [
      { label: 'Angular CLI 16', example: 'angular16-ng-new' },
      { label: 'Angular CLI 21', example: 'angular21-ng-new' },
      { label: 'Nx 20', example: 'nx20-create-angular-monorepo' }
    ]
  },
  {
    title: 'React',
    stacks: [
      { label: 'Redux Toolkit', example: 'redux-vite-template' },
      { label: 'TanStack Query', example: 'tanstack-query-basic' },
      { label: 'react-scripts', example: 'react-realworld' },
      { label: 'webpack-dev-server', example: 'todomvc-react' }
    ]
  },
  {
    title: 'TodoMVC',
    stacks: [
      { label: 'Angular', example: 'todomvc-angular' },
      { label: 'React', example: 'todomvc-react' },
      { label: 'Vue', example: 'todomvc-vue' },
      { label: 'Svelte', example: 'todomvc-svelte' }
    ]
  },
  {
    title: 'Svelte and Solid',
    stacks: [
      { label: 'SvelteKit', example: 'sveltekit-realworld' },
      { label: 'Svelte + Rollup', example: 'svelte3-rollup-template' },
      { label: 'Sapper', example: 'sapper-rollup' },
      { label: 'Solid', example: 'solid-vite-basic' },
      { label: 'SolidStart', example: 'solid-start2-basic' }
    ]
  },
  {
    title: 'Builders and sites',
    stacks: [
      { label: 'Astro', example: 'astro-basics' },
      { label: 'Rspack', example: 'rspack-react' },
      { label: 'Rsbuild', example: 'rsbuild-react' },
      { label: 'Rollup', example: 'rollup-starter-app' },
      { label: 'Eleventy', example: 'eleventy-base-blog' }
    ]
  },
  {
    title: 'Node servers',
    stacks: [
      { label: 'NestJS', example: 'nest-starter' },
      { label: 'Koa', example: 'koa-hello-world' },
      { label: 'Hono', example: 'hono-node' }
    ]
  }
];

/** Tooling with Compatibility Claims (the root README), which the playground does not open on its own. */
export const tooling: readonly string[] = [
  'npm',
  'pnpm',
  'Yarn',
  'TypeScript',
  'esbuild',
  'Rspack',
  'Rolldown',
  'Prettier',
  'ESLint',
  'Sass',
  'Vitest',
  'Jest',
  'Tailwind CSS',
  'webpack 4 and 5'
];

/** The title of the example a stack opens, for its tooltip. */
export function exampleTitle(id: string): string | undefined {
  return examples.find((example) => example.id === id)?.title;
}
