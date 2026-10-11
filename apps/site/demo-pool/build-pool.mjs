// Generates pool.json: the demo applications run in the playground.
// Kept as code so the matrix (stack × version) stays readable.
import { writeFileSync } from 'node:fs';

const apps = [];
const add = (app) => apps.push({ setup: ['npm install'], dev: 'npm run dev', ...app });
// Official generators run inside the container, in an otherwise empty repository.
const HOST = 'octocat/Hello-World';
const scaffold = (app) => add({ repo: HOST, origin: 'official generator', ...app });

// Vite: the create-vite templates as each Vite release shipped them.
const viteTemplates = {
  'v2.9.18': ['vanilla', 'react', 'vue', 'svelte'],
  'v3.2.11': ['react-ts', 'vue-ts', 'preact'],
  'v4.5.14': ['react', 'vue-ts', 'solid-ts', 'qwik-ts', 'lit'],
  'v5.4.21': ['react-ts', 'vue-ts', 'svelte-ts', 'preact-ts'],
  'v6.3.7': ['react-ts', 'vue', 'solid'],
  'v7.3.7': ['react-ts', 'vue-ts', 'svelte-ts', 'lit-ts'],
  'v8.3.4': ['react-ts', 'vue-ts', 'vanilla-ts', 'svelte-ts', 'solid-ts', 'qwik-ts']
};
for (const [tag, templates] of Object.entries(viteTemplates)) {
  const major = tag.slice(1).split('.')[0];
  for (const template of templates) {
    add({
      id: `vite${major}-${template}`,
      stack: 'Vite',
      title: `create-vite template-${template} (Vite ${major})`,
      origin: 'official template',
      repo: 'vitejs/vite',
      ref: tag,
      dir: `packages/create-vite/template-${template}`
    });
  }
}

// Angular CLI: `ng new` of each major, as angular.dev starts a project.
for (const major of [12, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
  scaffold({
    id: `angular${major}-ng-new`,
    stack: 'Angular',
    title: `ng new (Angular CLI ${major})`,
    setup: [`npx -y @angular/cli@${major} new demo --defaults --skip-git --skip-install --skip-tests`, 'cd demo', 'npm install'],
    dev: 'npm start'
  });
}
add({ id: 'angular-realworld', stack: 'Angular', title: 'RealWorld (Conduit) Angular app', origin: 'popular demo', repo: 'gothinkster/angular-realworld-example-app', dev: 'npm start' });
add({ id: 'ionic-angular-conference', stack: 'Angular', title: 'Ionic Conference App (Angular + Ionic)', origin: 'official demo', repo: 'ionic-team/ionic-conference-app', dev: 'npm start' });
add({ id: 'todomvc-angular', stack: 'Angular', title: 'TodoMVC Angular', origin: 'popular demo', repo: 'tastejs/todomvc', dir: 'examples/angular', dev: 'npm start' });
scaffold({ id: 'analog-create', stack: 'Angular', title: 'create-analog (Analog, Angular on Vite)', setup: ['npx -y create-analog@2 demo --template latest --skipTailwind true', 'cd demo', 'npm install'] });
add({ id: 'angular4-quickstart', stack: 'Angular', title: 'Angular 4 QuickStart (SystemJS + lite-server)', origin: 'official legacy', repo: 'angular/quickstart', dev: 'npm start' });
add({ id: 'angularjs-seed', stack: 'Angular', title: 'AngularJS angular-seed (http-server)', origin: 'official legacy', repo: 'angular/angular-seed', dev: 'npm start' });

// React outside the Vite templates.
scaffold({ id: 'cra5', stack: 'React', title: 'create-react-app 5 (react-scripts 5, webpack 5)', setup: ['npx -y create-react-app@5 demo', 'cd demo'], dev: 'npm start' });
add({ id: 'redux-todos-cra4', stack: 'React', title: 'Redux todos example (react-scripts 4, webpack 4)', origin: 'official example', repo: 'reduxjs/redux', dir: 'examples/todos', dev: 'npm start' });
add({ id: 'redux-vite-template', stack: 'React', title: 'Redux Toolkit Vite template', origin: 'official template', repo: 'reduxjs/redux-templates', dir: 'packages/vite-template-redux' });
add({ id: 'react-router7-default', stack: 'React', title: 'React Router 7 framework template', origin: 'official template', repo: 'remix-run/react-router-templates', dir: 'default' });
add({ id: 'remix2-vite', stack: 'React', title: 'Remix 2 template (Vite)', origin: 'official template', repo: 'remix-run/remix', ref: 'remix@2.17.5', dir: 'templates/remix' });
add({ id: 'tanstack-query-basic', stack: 'React', title: 'TanStack Query basic example', origin: 'official example', repo: 'TanStack/query', dir: 'examples/react/basic' });
add({ id: 'tanstack-router-vite', stack: 'React', title: 'TanStack Router quickstart, file-based (Vite)', origin: 'official example', repo: 'TanStack/router', dir: 'examples/react/quickstart-file-based' });
add({ id: 'tanstack-router-webpack', stack: 'React', title: 'TanStack Router quickstart, file-based (webpack)', origin: 'official example', repo: 'TanStack/router', dir: 'examples/react/quickstart-webpack-file-based' });
add({ id: 'tanstack-router-esbuild', stack: 'React', title: 'TanStack Router quickstart, file-based (esbuild serve)', origin: 'official example', repo: 'TanStack/router', dir: 'examples/react/quickstart-esbuild-file-based' });
add({ id: 'tanstack-start-basic', stack: 'React', title: 'TanStack Start basic', origin: 'official example', repo: 'TanStack/router', dir: 'examples/react/start-basic' });
add({ id: 'ionic-react-conference', stack: 'React', title: 'Ionic React Conference App (Vite)', origin: 'official demo', repo: 'ionic-team/ionic-react-conference-app' });
add({ id: 'react-realworld-cra1', stack: 'React', title: 'RealWorld React/Redux (react-scripts 1)', origin: 'popular demo', repo: 'gothinkster/react-redux-realworld-example-app', dev: 'npm start' });
add({ id: 'react-boilerplate', stack: 'React', title: 'react-boilerplate (webpack 4 + Express)', origin: 'popular demo', repo: 'react-boilerplate/react-boilerplate', dev: 'npm start' });
add({ id: 'todomvc-react', stack: 'React', title: 'TodoMVC React (webpack-dev-server 5)', origin: 'popular demo', repo: 'tastejs/todomvc', dir: 'examples/react' });
add({ id: 'react-tutorial-legacy', stack: 'React', title: 'React tutorial comment box (Express server)', origin: 'official legacy', repo: 'reactjs/react-tutorial', dev: 'npm start' });
add({ id: 'ant-design-pro', stack: 'React', title: 'Ant Design Pro (Umi Max)', origin: 'official demo', repo: 'ant-design/ant-design-pro' });
scaffold({ id: 'expo-web', stack: 'React', title: 'create-expo-app, web target (Metro)', setup: ['npx -y create-expo-app@latest demo --yes --no-install', 'cd demo', 'npm install'], dev: 'npx expo start --web' });

// Next.js
// create-next-app 12 installs the current Next; the pin makes the entry Next 12.
scaffold({ id: 'next12-pages', stack: 'Next.js', title: 'create-next-app 12 (pages), Next 12 pinned', setup: ['npx -y create-next-app@12 demo --use-npm', 'cd demo', 'npm install next@12 react@18 react-dom@18'] });
scaffold({ id: 'next13-pages', stack: 'Next.js', title: 'create-next-app 13 (pages, JS)', setup: ["npx -y create-next-app@13 demo --js --eslint --no-tailwind --no-src-dir --no-app --import-alias '@/*' --use-npm", 'cd demo'] });
scaffold({ id: 'next14-app', stack: 'Next.js', title: 'create-next-app 14 (app router, TS, Tailwind)', setup: ["npx -y create-next-app@14 demo --ts --eslint --tailwind --no-src-dir --app --import-alias '@/*' --use-npm", 'cd demo'] });
scaffold({ id: 'next15-app', stack: 'Next.js', title: 'create-next-app 15 (defaults)', setup: ['npx -y create-next-app@15 demo --yes --use-npm --skip-install', 'cd demo', 'npm install'] });
scaffold({ id: 'next15-app-webpack', stack: 'Next.js', title: 'create-next-app 15, `next dev` without Turbopack', setup: ['npx -y create-next-app@15 demo --yes --use-npm --skip-install', 'cd demo', 'npm install'], dev: 'npx next dev' });
scaffold({ id: 'next16-app', stack: 'Next.js', title: 'create-next-app 16 (defaults, Turbopack)', setup: ['npx -y create-next-app@16 demo --yes --use-npm --skip-install', 'cd demo', 'npm install'] });
scaffold({ id: 'next16-app-webpack', stack: 'Next.js', title: 'create-next-app 16, `next dev --webpack`', setup: ['npx -y create-next-app@16 demo --yes --use-npm --skip-install', 'cd demo', 'npm install'], dev: 'npx next dev --webpack' });
add({ id: 'next-learn-dashboard', stack: 'Next.js', title: 'Next.js Learn dashboard starter', origin: 'official course', repo: 'vercel/next-learn', dir: 'dashboard/starter-example', setup: ['pnpm install'], dev: 'pnpm dev' });
add({ id: 'next-learn-dashboard-webpack', stack: 'Next.js', title: 'Next.js Learn dashboard starter, `next dev --webpack`', origin: 'official course', repo: 'vercel/next-learn', dir: 'dashboard/starter-example', setup: ['pnpm install'], dev: 'pnpm exec next dev --webpack' });

// Vue
scaffold({ id: 'create-vue', stack: 'Vue', title: 'create-vue 3 (TS, Router, Pinia)', setup: ['npx -y create-vue@3 demo --ts --router --pinia', 'cd demo', 'npm install'] });
scaffold({ id: 'vue-cli5', stack: 'Vue', title: 'Vue CLI 5 default (webpack 5)', setup: ['npx -y @vue/cli@5 create demo --default --packageManager npm --no-git --skipGetStarted', 'cd demo'], dev: 'npm run serve' });
add({ id: 'vue-element-admin', stack: 'Vue', title: 'vue-element-admin (Vue 2, Vue CLI 4, webpack 4)', origin: 'popular demo', repo: 'PanJiaChen/vue-element-admin' });
add({ id: 'vue-realworld', stack: 'Vue', title: 'RealWorld Vue 3 (Vite)', origin: 'popular demo', repo: 'gothinkster/vue-realworld-example-app', dev: 'npm run serve' });
add({ id: 'todomvc-vue', stack: 'Vue', title: 'TodoMVC Vue (Vite)', origin: 'popular demo', repo: 'tastejs/todomvc', dir: 'examples/vue' });
for (const ref of ['v2', 'v3', 'v4']) {
  add({ id: `nuxt${ref.slice(1)}-starter`, stack: 'Vue', title: `Nuxt ${ref.slice(1)} starter`, origin: 'official template', repo: 'nuxt/starter', ref });
}

// Svelte
add({ id: 'svelte3-rollup-template', stack: 'Svelte', title: 'sveltejs/template (Svelte 3, Rollup)', origin: 'official legacy', repo: 'sveltejs/template' });
add({ id: 'sapper-rollup', stack: 'Svelte', title: 'Sapper template (Rollup)', origin: 'official legacy', repo: 'sveltejs/sapper-template', ref: 'rollup' });
add({ id: 'sveltekit-realworld', stack: 'Svelte', title: 'SvelteKit RealWorld (pnpm)', origin: 'official demo', repo: 'sveltejs/realworld', setup: ['pnpm install'], dev: 'pnpm dev' });
scaffold({ id: 'sveltekit-sv-create', stack: 'Svelte', title: 'sv create (SvelteKit minimal, TS)', setup: ['npx -y sv@1 create demo --template minimal --types ts --no-add-ons --no-install', 'cd demo', 'npm install'] });
add({ id: 'todomvc-svelte', stack: 'Svelte', title: 'TodoMVC Svelte 5 (Vite)', origin: 'popular demo', repo: 'tastejs/todomvc', dir: 'examples/svelte' });

// Solid
add({ id: 'solid-vite-basic', stack: 'Solid', title: 'Solid template vanilla/basic (Vite)', origin: 'official template', repo: 'solidjs/templates', dir: 'vanilla/basic' });
add({ id: 'solid-start1-basic', stack: 'Solid', title: 'SolidStart 1 basic (Vinxi)', origin: 'official template', repo: 'solidjs/templates', dir: 'solid-start-v1/basic' });
add({ id: 'solid-start2-basic', stack: 'Solid', title: 'SolidStart 2 basic (Vite 8)', origin: 'official template', repo: 'solidjs/templates', dir: 'solid-start-v2/basic' });

// Astro
add({ id: 'astro-basics', stack: 'Astro', title: 'Astro basics example', origin: 'official example', repo: 'withastro/astro', dir: 'examples/basics' });
add({ id: 'astro-blog', stack: 'Astro', title: 'Astro blog example', origin: 'official example', repo: 'withastro/astro', dir: 'examples/blog' });
add({ id: 'astro-react', stack: 'Astro', title: 'Astro with React islands', origin: 'official example', repo: 'withastro/astro', dir: 'examples/framework-react' });
add({ id: 'starlight-basics', stack: 'Astro', title: 'Starlight docs starter', origin: 'official example', repo: 'withastro/starlight', dir: 'examples/basics' });

// Nx
add({ id: 'nx-examples', stack: 'Nx', title: 'nx-examples (Nx 23, Angular shop, Yarn 4)', origin: 'official example', repo: 'nrwl/nx-examples', setup: ['yarn install'], dev: 'npx nx serve products' });
add({ id: 'nx18-react-standalone', stack: 'Nx', title: 'Nx 18 React standalone (Vite)', origin: 'official recipe', repo: 'nrwl/nx-recipes', dir: 'react-standalone', dev: 'npm start' });
add({ id: 'nx18-angular-standalone', stack: 'Nx', title: 'Nx 18 Angular 17 standalone', origin: 'official recipe', repo: 'nrwl/nx-recipes', dir: 'angular-standalone', dev: 'npm start' });
add({ id: 'nx18-vue-standalone', stack: 'Nx', title: 'Nx 18 Vue standalone (Vite)', origin: 'official recipe', repo: 'nrwl/nx-recipes', dir: 'vue-standalone', dev: 'npm start' });
add({ id: 'nx20-react-monorepo', stack: 'Nx', title: 'Nx 20 React monorepo (Vite)', origin: 'official recipe', repo: 'nrwl/nx-recipes', dir: 'react-monorepo', dev: 'npx nx serve react-store' });
add({ id: 'nx21-angular-monorepo', stack: 'Nx', title: 'Nx 21 Angular 20 monorepo', origin: 'official recipe', repo: 'nrwl/nx-recipes', dir: 'angular-monorepo', dev: 'npx nx serve angular-store' });
scaffold({ id: 'nx21-create-react-monorepo', stack: 'Nx', title: 'create-nx-workspace 21 --preset=react-monorepo (Vite)', setup: ['npx -y create-nx-workspace@21 demo --preset=react-monorepo --appName=web --bundler=vite --style=css --e2eTestRunner=none --unitTestRunner=none --linter=none --formatter=none --nxCloud=skip --packageManager=npm --interactive=false --skipGit', 'cd demo'], dev: 'npx nx serve web' });
scaffold({ id: 'nx20-create-angular-monorepo', stack: 'Nx', title: 'create-nx-workspace 20 --preset=angular-monorepo (esbuild)', setup: ['npx -y create-nx-workspace@20 demo --preset=angular-monorepo --appName=web --bundler=esbuild --style=css --e2eTestRunner=none --unitTestRunner=none --ssr=false --nxCloud=skip --packageManager=npm --interactive=false --skipGit', 'cd demo'], dev: 'npx nx serve web' });

// webpack, Rspack, Parcel, Rollup, esbuild and other bundlers
scaffold({ id: 'webpack-create-app', stack: 'webpack', title: 'create-webpack-app init (webpack 5, webpack-cli 7)', setup: ['npx -y create-webpack-app@2 init demo --force', 'cd demo'], dev: 'npm run serve' });
add({ id: 'phaser-webpack', stack: 'webpack', title: 'Phaser 4 webpack template', origin: 'official template', repo: 'phaserjs/template-webpack' });
add({ id: 'rspack-react', stack: 'Rspack', title: 'Rspack React example', origin: 'official example', repo: 'rspack-contrib/rspack-examples', dir: 'rspack/react' });
add({ id: 'rspack-vue', stack: 'Rspack', title: 'Rspack Vue example', origin: 'official example', repo: 'rspack-contrib/rspack-examples', dir: 'rspack/vue' });
add({ id: 'rsbuild-react', stack: 'Rspack', title: 'Rsbuild React example', origin: 'official example', repo: 'rspack-contrib/rspack-examples', dir: 'rsbuild/react' });
add({ id: 'rsbuild-vue', stack: 'Rspack', title: 'Rsbuild Vue example', origin: 'official example', repo: 'rspack-contrib/rspack-examples', dir: 'rsbuild/vue' });
add({ id: 'rspress-basic', stack: 'Rspack', title: 'Rspress docs example', origin: 'official example', repo: 'rspack-contrib/rspack-examples', dir: 'rspress/basic' });
scaffold({ id: 'parcel-react', stack: 'Parcel', title: 'create-parcel react-client (Parcel 2)', setup: ['npx -y create-parcel@2 react-client demo', 'cd demo'], dev: 'npm start' });
add({ id: 'rollup-starter-app', stack: 'Rollup', title: 'rollup-starter-app (Rollup 2 + serve)', origin: 'official template', repo: 'rollup/rollup-starter-app' });
scaffold({ id: 'snowpack-react', stack: 'Snowpack', title: 'create-snowpack-app React template', setup: ['npx -y create-snowpack-app@1 demo --template @snowpack/app-template-react --use-npm --no-install', 'cd demo', 'npm install'], dev: 'npm start' });
add({ id: 'phaser-vite', stack: 'Vite', title: 'Phaser 4 Vite template', origin: 'official template', repo: 'phaserjs/template-vite' });

// Other front-end stacks
add({ id: 'lit-starter-ts', stack: 'Lit', title: 'Lit element starter (TS, Web Dev Server)', origin: 'official template', repo: 'lit/lit-element-starter-ts', setup: ['npm install', 'npm run build'], dev: 'npm run serve' });
add({ id: 'stencil-starter', stack: 'Stencil', title: 'Stencil component starter', origin: 'official template', repo: 'ionic-team/stencil-component-starter', dev: 'npm start' });
scaffold({ id: 'ember-new', stack: 'Ember', title: 'ember new (Ember CLI 6, Vite)', setup: ['npx -y ember-cli@6 new demo --skip-git --skip-npm --no-welcome', 'cd demo', 'npm install'], dev: 'npm start' });
add({ id: 'eleventy-base-blog', stack: '11ty', title: 'Eleventy base blog', origin: 'official template', repo: '11ty/eleventy-base-blog', dev: 'npm start' });
scaffold({ id: 'docusaurus-classic', stack: 'Docusaurus', title: 'create-docusaurus 3 classic (webpack)', setup: ['npx -y create-docusaurus@3 demo classic --javascript --skip-install', 'cd demo', 'npm install'], dev: 'npm start' });
add({ id: 'gatsby-starter-default', stack: 'Gatsby', title: 'Gatsby 5 default starter', origin: 'official template', repo: 'gatsbyjs/gatsby-starter-default', dev: 'npm run develop' });
add({ id: 'gatsby-starter-blog', stack: 'Gatsby', title: 'Gatsby 5 blog starter', origin: 'official template', repo: 'gatsbyjs/gatsby-starter-blog', dev: 'npm run develop' });

// Node servers
add({ id: 'nest-starter', stack: 'Node server', title: 'NestJS TypeScript starter', origin: 'official template', repo: 'nestjs/typescript-starter', dev: 'npm run start' });
scaffold({ id: 'express-generator', stack: 'Node server', title: 'express-generator (Express 4, EJS)', setup: ['npx -y express-generator@4 --view=ejs demo', 'cd demo', 'npm install'], dev: 'npm start' });
scaffold({ id: 'fastify-cli', stack: 'Node server', title: 'fastify-cli generate (Fastify 5)', setup: ['npx -y fastify-cli@8 generate demo', 'cd demo', 'npm install'] });
add({ id: 'socketio-chat', stack: 'Node server', title: 'Socket.IO chat example', origin: 'official example', repo: 'socketio/chat-example', dev: 'npm start' });
add({ id: 'koa-hello-world', stack: 'Node server', title: 'Koa examples: hello-world', origin: 'official example', repo: 'koajs/examples', dev: 'node hello-world/app.js' });
add({ id: 'hono-node', stack: 'Node server', title: 'Hono Node.js starter (tsx watch)', origin: 'official template', repo: 'honojs/starter', dir: 'templates/nodejs' });

const ids = new Set();
for (const app of apps) {
  if (ids.has(app.id)) throw new Error(`duplicate id ${app.id}`);
  ids.add(app.id);
}
writeFileSync(new URL('./pool.json', import.meta.url), JSON.stringify({ host: HOST, apps }, null, 2) + '\n');
console.log(`${apps.length} applications`);
