import {
  siAngular,
  siAstro,
  siCreatereactapp,
  siEleventy,
  siEsbuild,
  siEslint,
  siHono,
  siJest,
  siKoa,
  siLit,
  siNestjs,
  siNpm,
  siNx,
  siPnpm,
  siPreact,
  siPrettier,
  siReact,
  siReactquery,
  siRedux,
  siRolldown,
  siRollupdotjs,
  siSass,
  siSolid,
  siSvelte,
  siTailwindcss,
  siTypescript,
  siVite,
  siVitest,
  siVuedotjs,
  siWebpack,
  siYarn,
  type SimpleIcon
} from 'simple-icons';
import { examples } from '../playground/examples';

/**
 * A stack shown on the landing page; `example` opens it in the playground.
 * `icon` is its Simple Icons logo; without one (Simple Icons has no Phaser,
 * Rspack or Rsbuild) the chip shows a letter mark.
 */
export type Stack = { readonly label: string; readonly example?: string; readonly icon?: SimpleIcon };

export type StackGroup = { readonly title: string; readonly stacks: readonly Stack[] };

/** What the playground opens, by group: each one is an example of `../playground/examples.ts`. */
export const playgroundStacks: readonly StackGroup[] = [
  {
    title: 'Vite',
    stacks: [
      { label: 'React', example: 'vite8-react-ts', icon: siReact },
      { label: 'Vue', example: 'vite8-vue-ts', icon: siVuedotjs },
      { label: 'Svelte', example: 'vite8-svelte-ts', icon: siSvelte },
      { label: 'Solid', example: 'vite8-solid-ts', icon: siSolid },
      { label: 'Lit', example: 'vite7-lit-ts', icon: siLit },
      { label: 'Preact', example: 'vite5-preact-ts', icon: siPreact },
      { label: 'Vanilla TypeScript', example: 'vite8-vanilla-ts', icon: siTypescript },
      { label: 'Phaser', example: 'phaser-vite' }
    ]
  },
  {
    title: 'Angular and Nx',
    stacks: [
      { label: 'Angular CLI 16', example: 'angular16-ng-new', icon: siAngular },
      { label: 'Angular CLI 21', example: 'angular21-ng-new', icon: siAngular },
      { label: 'Nx 20', example: 'nx20-create-angular-monorepo', icon: siNx }
    ]
  },
  {
    title: 'React',
    stacks: [
      { label: 'Redux Toolkit', example: 'redux-vite-template', icon: siRedux },
      { label: 'TanStack Query', example: 'tanstack-query-basic', icon: siReactquery },
      { label: 'react-scripts', example: 'react-realworld', icon: siCreatereactapp },
      { label: 'webpack-dev-server', example: 'todomvc-react', icon: siWebpack }
    ]
  },
  {
    title: 'TodoMVC',
    stacks: [
      { label: 'Angular', example: 'todomvc-angular', icon: siAngular },
      { label: 'React', example: 'todomvc-react', icon: siReact },
      { label: 'Vue', example: 'todomvc-vue', icon: siVuedotjs },
      { label: 'Svelte', example: 'todomvc-svelte', icon: siSvelte }
    ]
  },
  {
    title: 'Svelte and Solid',
    stacks: [
      { label: 'SvelteKit', example: 'sveltekit-realworld', icon: siSvelte },
      { label: 'Svelte + Rollup', example: 'svelte3-rollup-template', icon: siSvelte },
      { label: 'Sapper', example: 'sapper-rollup', icon: siSvelte },
      { label: 'Solid', example: 'solid-vite-basic', icon: siSolid },
      { label: 'SolidStart', example: 'solid-start2-basic', icon: siSolid }
    ]
  },
  {
    title: 'Builders and sites',
    stacks: [
      { label: 'Astro', example: 'astro-basics', icon: siAstro },
      { label: 'Rspack', example: 'rspack-react' },
      { label: 'Rsbuild', example: 'rsbuild-react' },
      { label: 'Rollup', example: 'rollup-starter-app', icon: siRollupdotjs },
      { label: 'Eleventy', example: 'eleventy-base-blog', icon: siEleventy }
    ]
  },
  {
    title: 'Node servers',
    stacks: [
      { label: 'NestJS', example: 'nest-starter', icon: siNestjs },
      { label: 'Koa', example: 'koa-hello-world', icon: siKoa },
      { label: 'Hono', example: 'hono-node', icon: siHono }
    ]
  }
];

/** Tooling with Compatibility Claims (the root README), which the playground does not open on its own. */
export const tooling: readonly Stack[] = [
  { label: 'npm', icon: siNpm },
  { label: 'pnpm', icon: siPnpm },
  { label: 'Yarn', icon: siYarn },
  { label: 'TypeScript', icon: siTypescript },
  { label: 'esbuild', icon: siEsbuild },
  { label: 'Rspack' },
  { label: 'Rolldown', icon: siRolldown },
  { label: 'Prettier', icon: siPrettier },
  { label: 'ESLint', icon: siEslint },
  { label: 'Sass', icon: siSass },
  { label: 'Vitest', icon: siVitest },
  { label: 'Jest', icon: siJest },
  { label: 'Tailwind CSS', icon: siTailwindcss },
  { label: 'webpack 4 and 5', icon: siWebpack }
];

/** The title of the example a stack opens, for its tooltip. */
export function exampleTitle(id: string): string | undefined {
  return examples.find((example) => example.id === id)?.title;
}
