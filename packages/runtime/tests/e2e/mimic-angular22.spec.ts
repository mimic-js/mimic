import { AngularDevSuite } from './angular-dev-suite';
import { defineCompatibilityClaim } from './compatibility-claim';

const angular22Claim = defineCompatibilityClaim({
  id: 'angular-22-1-0-scss-dev-exact-graph',
  statement:
    'Angular 22.1.0 preserves cold, warm-cache, reload, HMR, cleanup, teardown, and pristine-reboot development through the local Angular CLI server',
  target: {
    kind: 'exact-graph',
    packages: {
      '@angular/core': '22.1.0',
      '@angular/cli': '22.1.0',
      '@angular/build': '22.1.0',
      '@rolldown/binding-wasm32-wasi': '1.2.0',
      '@oxc-project/types': '0.140.0',
      typescript: '6.0.2',
      vite: '8.1.5',
      esbuild: '0.28.1',
      rolldown: '1.2.0',
      'oxc-parser': '0.140.0',
      'vite>rolldown': '1.1.5',
      'vite>@rolldown/binding-wasm32-wasi': '1.1.5',
      'vite>@oxc-project/types': '0.139.0',
      sass: '1.101.0',
      lightningcss: '1.33.0'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/angular-22.1.0/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {
      lightningcss: 'lightningcss-wasm@1.33.0'
    },
    execution: { command: 'npm run start', entrypoint: 'node_modules/@angular/cli/bin/ng.js' }
  }
});

const suite = new AngularDevSuite({
  framework: 'Angular 22',
  installed: {
    '@angular/core': '@angular/core@22.1.0',
    '@angular/cli': '@angular/cli@22.1.0',
    '@angular/build': '@angular/build@22.1.0',
    typescript: 'typescript@6.0.2',
    vite: 'vite@8.1.5',
    esbuild: 'esbuild@0.28.1',
    rolldown: 'rolldown@1.2.0',
    '@rolldown/binding-wasm32-wasi': '@rolldown/binding-wasm32-wasi@1.2.0',
    'oxc-parser': 'oxc-parser@0.140.0',
    '@oxc-project/types': '@oxc-project/types@0.140.0',
    'vite/node_modules/rolldown': 'rolldown@1.1.5',
    'vite/node_modules/@rolldown/binding-wasm32-wasi': '@rolldown/binding-wasm32-wasi@1.1.5',
    'vite/node_modules/@oxc-project/types': '@oxc-project/types@0.139.0',
    sass: 'sass@1.101.0',
    lightningcss: 'lightningcss-wasm@1.33.0'
  },
  projectName: 'angular-22-1-0',
  preservedState: {
    selector: '[data-state]',
    initial: 'Count: 0',
    updated: 'Count: 1'
  },
  styles: {
    componentColor: 'rgb(29, 78, 216)',
    bodyBackground: 'rgb(255, 247, 237)'
  }
});

suite.register({ claim: angular22Claim, expectedHeading: 'Angular 22 SCSS is running' });
