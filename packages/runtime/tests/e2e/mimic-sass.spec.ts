import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const sass1973Claim = defineCompatibilityClaim({
  id: 'sass-1-97-3-node-api-cli-exact-graph',
  statement:
    'Sass 1.97.3 installs from the Angular 21 exact graph and compiles SCSS through its published Node API and CLI',
  target: sassExactGraphTarget('1.97.3')
});

const sass11010Claim = defineCompatibilityClaim({
  id: 'sass-1-101-0-node-api-cli-exact-graph',
  statement:
    'Sass 1.101.0 installs from the Angular 22 exact graph and compiles SCSS through its published Node API and CLI',
  target: sassExactGraphTarget('1.101.0')
});

// The native watcher packages the graph names as optional; none may be installed here.
const nativeWatchers = [
  'android-arm64',
  'darwin-arm64',
  'darwin-x64',
  'freebsd-x64',
  'linux-arm-glibc',
  'linux-arm-musl',
  'linux-arm64-glibc',
  'linux-arm64-musl',
  'linux-x64-glibc',
  'linux-x64-musl',
  'win32-arm64',
  'win32-x64'
].map((platform) => `node_modules/@parcel/watcher-${platform}/package.json`);

for (const [claim, version] of [
  [sass1973Claim, '1.97.3'],
  [sass11010Claim, '1.101.0']
] as const) {
  test.describe(() => {
    test.use({ fixture: `sass-${version}` });

    test(claim.statement, async ({ stack }) => {
      await stack.install();
      expect(JSON.parse(await stack.readFile('node_modules/sass/package.json'))).toMatchObject({
        name: 'sass',
        version,
        bin: { sass: 'sass.js' }
      });
      for (const manifest of nativeWatchers) expect(await stack.exists(manifest), manifest).toBe(false);

      const reported = await stack.run('npm exec -- sass --version', { timeoutMs: 60_000 });
      expect(reported.exitCode, reported.output).toBe(0);
      expect(reported.output).toContain(version);

      const api = await stack.run('node api.cjs', { timeoutMs: 60_000 });
      expect(api.exitCode, api.output).toBe(0);
      const marker = '__SASS_API__';
      const line = api.output.split(/\r?\n/u).find((candidate) => candidate.startsWith(marker));
      expect(line, api.output).toBeDefined();
      const compiled = JSON.parse(line!.slice(marker.length));
      expect(compiled.info).toContain(`dart-sass\t${version}`);
      expect(compiled.css).toContain('color: #336699;');
      expect(compiled.css).toContain('width: 4rem;');
      expect(compiled.loadedUrls).toEqual([`file://${stack.workdir}/api.scss`]);
      expect(compiled.sourceMap.sources).toEqual([expect.stringMatching(/api\.scss$/u)]);
      expect(compiled.sourceMap.sourcesContent).toEqual([await stack.readFile('api.scss')]);
      expect(compiled.sourceMap.mappings).not.toBe('');

      const cli = await stack.run('npm exec -- sass --source-map --embed-sources cli.scss cli.css', {
        timeoutMs: 60_000
      });
      expect(cli.exitCode, cli.output).toBe(0);
      expect(await stack.readFile('cli.css')).toContain('padding: 12px;');
      const cliSourceMap = JSON.parse(await stack.readFile('cli.css.map'));
      expect(cliSourceMap.sources).toEqual(['cli.scss']);
      expect(cliSourceMap.sourcesContent).toEqual([await stack.readFile('cli.scss')]);
      expect(cliSourceMap.mappings).not.toBe('');

      const malformed = await stack.run('npm exec -- sass broken.scss', { timeoutMs: 60_000 });
      expect(malformed.exitCode, malformed.output).not.toBe(0);
      expect(malformed.output).toContain('Error: expected "}"');
      expect(malformed.output).toContain('broken.scss');
    });
  });
}

function sassExactGraphTarget(version: string) {
  return {
    kind: 'exact-graph',
    packages: { sass: version },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: `compatibility/fixtures/sass-${version}/package-lock.json`
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {},
    execution: { command: 'node api.cjs and npm exec sass', entrypoint: 'sass.js' }
  } as const;
}
