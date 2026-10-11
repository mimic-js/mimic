import { AngularDevSuite } from './angular-dev-suite';
import { defineCompatibilityClaim } from './compatibility-claim';

const angular21Claim = defineCompatibilityClaim({
  id: 'angular-21-2-19-scss-dev-exact-graph',
  statement:
    'Angular 21.2.19 preserves cold, warm-cache, reload, HMR, cleanup, teardown, and pristine-reboot development through the local Angular CLI server',
  target: {
    kind: 'exact-graph',
    packages: {
      '@angular/core': '21.2.19',
      '@angular/cli': '21.2.19',
      '@angular/build': '21.2.19',
      '@rollup/wasm-node': '4.62.4',
      typescript: '5.9.3',
      vite: '7.3.6',
      esbuild: '0.28.1',
      rollup: '4.62.4',
      rolldown: '1.0.0-rc.4',
      '@rolldown/binding-wasm32-wasi': '1.0.0-rc.4',
      sass: '1.97.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/angular-21.2.19/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.4'
    },
    execution: { command: 'npm run start', entrypoint: 'node_modules/@angular/cli/bin/ng.js' }
  }
});

const suite = new AngularDevSuite({
  framework: 'Angular 21',
  installed: {
    '@angular/core': '@angular/core@21.2.19',
    '@angular/cli': '@angular/cli@21.2.19',
    '@angular/build': '@angular/build@21.2.19',
    typescript: 'typescript@5.9.3',
    vite: 'vite@7.3.6',
    esbuild: 'esbuild@0.28.1',
    rollup: '@rollup/wasm-node@4.62.4',
    rolldown: 'rolldown@1.0.0-rc.4',
    '@rolldown/binding-wasm32-wasi': '@rolldown/binding-wasm32-wasi@1.0.0-rc.4',
    sass: 'sass@1.97.3'
  },
  projectName: 'angular-21-2-19',
  styles: {
    componentColor: 'rgb(91, 33, 182)',
    bodyBackground: 'rgb(245, 243, 255)'
  }
});

suite.register({ claim: angular21Claim, expectedHeading: 'Angular 21 SCSS is running' });
