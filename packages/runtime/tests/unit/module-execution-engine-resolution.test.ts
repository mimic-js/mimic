import { describe, expect, test } from 'vitest';
import { zipSync } from 'fflate';

import {
  createModuleResolver,
  resolveVfsModuleSpecifier
} from '../../src/runtime/modules/module-execution-engine/module-resolution';
import {
  ModuleResolutionError
} from '../../src/runtime/modules/module-execution-engine/module-resolution-types';
import {
  type VfsCommitJournalRecord,
  type VfsCommitOperation
} from '../../src/runtime/modules/virtual-file-system';
import {
  VirtualFileSystem
} from '../../src/runtime/modules/virtual-file-system/virtual-file-system';

describe('Module Execution Engine resolution', () => {
  test('owns package entries, conditional exports, package imports, and path normalization', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.mkdir('/home/project/src/nested', { recursive: true });
    await fs.writeFile(
      '/home/project/package.json',
      JSON.stringify({
        name: 'resolver-test',
        version: '0.0.0',
        imports: {
          '#internal': {
            browser: {
              import: './src/internal-production.js',
              development: './src/internal-development.js'
            },
            default: './src/internal-default.js'
          }
        }
      })
    );
    await fs.writeFile('/home/project/src/internal-development.js', 'export const mode = "development";\n');
    await fs.writeFile('/home/project/src/internal-production.js', 'export const mode = "production";\n');
    await fs.writeFile('/home/project/src/internal-default.js', 'export const mode = "default";\n');
    await writePackage(fs, '@scope/conditional-pkg', {
      manifest: {
        name: '@scope/conditional-pkg',
        version: '1.0.0',
        browser: 'legacy-browser.js',
        exports: {
          '.': {
            browser: {
              import: './browser-production.js',
              development: './browser-development.js'
            },
            require: './require.cjs',
            default: './default.js'
          },
          './feature': {
            browser: './feature-browser.js',
            import: './feature-import.js'
          }
        }
      },
      files: {
        'legacy-browser.js': 'module.exports = "legacy-browser";\n',
        'browser-development.js': 'export const entry = "browser-development";\n',
        'browser-production.js': 'export const entry = "browser-production";\n',
        'require.cjs': 'module.exports = "require";\n',
        'default.js': 'export const entry = "default";\n',
        'feature-browser.js': 'export const feature = "browser";\n',
        'feature-import.js': 'export const feature = "import";\n'
      }
    });
    await writePackage(fs, 'browser-map', {
      manifest: {
        name: 'browser-map',
        version: '1.0.0',
        main: 'server.js',
        browser: {
          './server.js': './client.js'
        }
      },
      files: {
        'server.js': 'module.exports = "server";\n',
        'client.js': 'module.exports = "client";\n'
      }
    });
    await writePackage(fs, 'browser-rejection-stub', {
      manifest: {
        name: 'browser-rejection-stub',
        version: '1.0.0',
        browser: 'legacy-browser.js',
        exports: {
          '.': {
            import: './wrapper.mjs',
            browser: './browser.js',
            require: './index.cjs'
          }
        }
      },
      files: {
        'legacy-browser.js': 'throw new Error("legacy browser rejection");\n',
        'browser.js': 'throw new Error("browser rejection");\n',
        'wrapper.mjs': 'export const transport = true;\n',
        'index.cjs': 'module.exports = { transport: true };\n'
      }
    });

    const resolver = createModuleResolver(fs, { cwd: '/home/project' });

    expect(resolver.resolve('../internal-development', '/home/project/src/nested')).toBe(
      '/home/project/src/internal-development.js'
    );
    expect(resolver.resolve('file:///home/project/src/internal-development.js', '/home/project/src')).toBe(
      '/home/project/src/internal-development.js'
    );
    // A file URL is parsed as a URL, so `file:/path` (what `path.join` makes of a file URL) names the same file.
    expect(resolver.resolve('file:/home/project/src/nested/../internal-development.js', '/home/project/src', 'import')).toBe(
      '/home/project/src/internal-development.js'
    );
    expect(resolver.resolve('file://localhost/home/project/src/internal-development.js', '/home/project', 'import')).toBe(
      '/home/project/src/internal-development.js'
    );
    expect(resolver.resolve('@scope/conditional-pkg', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/@scope/conditional-pkg/default.js'
    );
    expect(resolver.resolve('@scope/conditional-pkg', '/home/project/src', 'require')).toBe(
      '/home/project/node_modules/@scope/conditional-pkg/require.cjs'
    );
    expect(resolver.resolve('@scope/conditional-pkg/feature', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/@scope/conditional-pkg/feature-import.js'
    );
    expect(resolver.resolve('browser-map', '/home/project/src', 'require')).toBe(
      '/home/project/node_modules/browser-map/server.js'
    );
    // Node resolution reads `main` for both modes; the `browser` field belongs to bundlers.
    expect(resolver.resolve('browser-map', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/browser-map/server.js'
    );
    expect(resolver.resolve('browser-rejection-stub', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/browser-rejection-stub/wrapper.mjs'
    );
    expect(resolver.resolve('browser-rejection-stub', '/home/project/src', 'require')).toBe(
      '/home/project/node_modules/browser-rejection-stub/index.cjs'
    );
    expect(resolver.resolve('#internal', '/home/project/src', 'import')).toBe(
      '/home/project/src/internal-default.js'
    );
    expect(() => resolver.resolve('missing-pkg', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({
        kind: 'module-not-found',
        message: "Cannot find module 'missing-pkg' from /home/project/src"
      })
    );
    expect(() => resolver.resolve('missing-pkg', '/home/project/src', 'import')).toThrow(ModuleResolutionError);
  });

  test('resolves optional VFS module specifiers for optimize-deps callers', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.mkdir('/home/project/src', { recursive: true });
    await fs.writeFile('/home/project/src/main.ts', 'import value from "typed-pkg";\n');
    await writePackage(fs, 'typed-pkg', {
      manifest: {
        name: 'typed-pkg',
        version: '1.0.0',
        exports: {
          '.': {
            browser: {
              import: './src/browser-production.ts',
              development: './src/browser-development.ts'
            },
            default: './src/default.js'
          }
        }
      },
      files: {
        'src/browser-development.ts': 'export default "development";\n',
        'src/browser-production.ts': 'export default "production";\n',
        'src/default.js': 'export default "default";\n'
      }
    });
    await writePackage(fs, 'node-surface-pkg', {
      manifest: {
        name: 'node-surface-pkg',
        version: '1.0.0',
        exports: {
          '.': {
            browser: './browser.js',
            import: './wrapper.mjs'
          }
        }
      },
      files: {
        'browser.js': 'throw new Error("browser-only entry");\n',
        'wrapper.mjs': 'export default "node-wrapper";\n'
      }
    });

    expect(resolveVfsModuleSpecifier('typed-pkg', '/home/project/src/main.ts', fs, '/home/project')).toBe(
      '/home/project/node_modules/typed-pkg/src/default.js'
    );
    expect(resolveVfsModuleSpecifier('node-surface-pkg', '/home/project/src/main.ts', fs, '/home/project')).toBe(
      '/home/project/node_modules/node-surface-pkg/wrapper.mjs'
    );
    expect(resolveVfsModuleSpecifier('./main', '/home/project/src/entry.ts', fs, '/home/project')).toBe(
      '/home/project/src/main.ts'
    );
    expect(resolveVfsModuleSpecifier('node:fs', '/home/project/src/main.ts', fs, '/home/project')).toBeUndefined();
    expect(resolveVfsModuleSpecifier('missing-pkg', '/home/project/src/main.ts', fs, '/home/project')).toBeUndefined();
  });

  test('uses Node 22.13 package identities for exports, imports, self-references, conditions, and symlinks', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.mkdir('/home/project/src/public', { recursive: true });
    await fs.writeFile(
      '/home/project/package.json',
      JSON.stringify({
        name: 'self-aware',
        version: '1.0.0',
        exports: {
          '.': './src/self.js',
          './public/*': './src/public/*.js'
        },
        imports: {
          '#blocked': [null, './src/public/feature.js'],
          '#external': 'external-target/features/entry',
          '#fallback': ['../invalid.js', './src/public/feature.js'],
          '#internal/*': './src/public/*.js',
          '#missing': ['./src/missing.js', './src/public/feature.js'],
          '#nested-blocked': [['../invalid.js', null], './src/public/feature.js']
        }
      })
    );
    await fs.writeFile('/home/project/src/self.js', 'export const self = true;\n');
    await fs.writeFile('/home/project/src/private.js', 'export const privateValue = true;\n');
    await fs.writeFile('/home/project/src/public/feature.js', 'export const feature = true;\n');
    await fs.writeFile('/home/project/src/actual.js', 'export const actual = true;\n');
    await fs.symlink('actual.js', '/home/project/src/alias.js');
    await writePackage(fs, 'external-target', {
      manifest: {
        name: 'external-target',
        version: '1.0.0',
        exports: {
          './features/*': './dist/*.js',
          './fallback': ['../invalid.js', './dist/entry.js'],
          './blocked': [null, './dist/entry.js'],
          './missing': ['./dist/missing.js', './dist/entry.js'],
          './nested-blocked': [['../invalid.js', null], './dist/entry.js']
        }
      },
      files: {
        'dist/entry.js': 'export const entry = true;\n',
        'private.js': 'export const privateValue = true;\n'
      }
    });
    await writePackage(fs, 'condition-order', {
      manifest: {
        name: 'condition-order',
        version: '1.0.0',
        exports: {
          '.': {
            default: './default.js',
            import: './import.js',
            browser: './browser.js'
          }
        }
      },
      files: {
        'default.js': 'export const condition = "default";\n',
        'import.js': 'export const condition = "import";\n',
        'browser.js': 'export const condition = "browser";\n'
      }
    });

    const resolver = createModuleResolver(fs, { cwd: '/home/project' });

    expect(resolver.resolve('self-aware', '/home/project/src', 'import')).toBe('/home/project/src/self.js');
    expect(resolver.resolve('self-aware/public/feature', '/home/project/src', 'import')).toBe(
      '/home/project/src/public/feature.js'
    );
    expect(() => resolver.resolve('self-aware/src/private.js', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-path-not-exported' })
    );
    expect(() => resolver.resolve('external-target/private.js', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-path-not-exported' })
    );
    expect(resolver.resolve('#external', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/external-target/dist/entry.js'
    );
    expect(resolver.resolve('#internal/feature', '/home/project/src', 'import')).toBe('/home/project/src/public/feature.js');
    expect(resolver.resolve('#fallback', '/home/project/src', 'import')).toBe('/home/project/src/public/feature.js');
    expect(resolver.resolve('external-target/fallback', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/external-target/dist/entry.js'
    );
    expect(() => resolver.resolve('#blocked', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-import-not-defined' })
    );
    expect(() => resolver.resolve('#missing', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'module-not-found' })
    );
    expect(() => resolver.resolve('#nested-blocked', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-import-not-defined' })
    );
    expect(() => resolver.resolve('external-target/blocked', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-path-not-exported' })
    );
    expect(() => resolver.resolve('external-target/missing', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'module-not-found' })
    );
    expect(() => resolver.resolve('external-target/nested-blocked', '/home/project/src', 'import')).toThrow(
      expect.objectContaining({ kind: 'package-path-not-exported' })
    );
    expect(resolver.resolve('condition-order', '/home/project/src', 'import')).toBe(
      '/home/project/node_modules/condition-order/default.js'
    );
    expect(resolver.resolve('./alias.js', '/home/project/src', 'import')).toBe('/home/project/src/actual.js');
  });

  test('activates only Node conditions unless custom conditions are explicitly configured', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await writePackage(fs, 'custom-condition', {
      manifest: {
        name: 'custom-condition',
        version: '1.0.0',
        exports: {
          '.': {
            development: './development.js',
            default: './default.js'
          }
        }
      },
      files: {
        'development.js': 'export const condition = "development";\n',
        'default.js': 'export const condition = "default";\n'
      }
    });

    expect(createModuleResolver(fs, { cwd: '/home/project' }).resolve('custom-condition', '/home/project')).toBe(
      '/home/project/node_modules/custom-condition/default.js'
    );
    expect(
      createModuleResolver(fs, { cwd: '/home/project', conditions: ['development'] }).resolve(
        'custom-condition',
        '/home/project'
      )
    ).toBe('/home/project/node_modules/custom-condition/development.js');
  });

  test('resolves declared PnP dependencies from read-only ZIP archive paths', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.mkdir('/home/project/.yarn/cache', { recursive: true });
    await fs.mkdir('/home/project/node_modules/pnp-leaf', { recursive: true });
    await fs.mkdir('/home/project/scripts', { recursive: true });
    await fs.writeFile('/home/project/node_modules/pnp-leaf/index.js', 'module.exports = { shadow: true };\n');
    await fs.writeFile('/home/project/scripts/check.cjs', "require('pnp-payload');\n");
    expect(() => createModuleResolver(fs, { cwd: '/home/project', pnp: true })).toThrow(
      'Cannot activate PnP without /home/project/.pnp.data.json'
    );
    await fs.writeFile(
      '/home/project/.yarn/cache/pnp-graph.zip',
      zipSync({
        'node_modules/pnp-payload/package.json': new TextEncoder().encode(
          JSON.stringify({ name: 'pnp-payload', exports: { import: './index.mjs', require: './index.cjs' } })
        ),
        'node_modules/pnp-payload/index.cjs': new TextEncoder().encode("module.exports = require('pnp-leaf');\n"),
        'node_modules/pnp-payload/index.mjs': new TextEncoder().encode("export { value } from 'pnp-leaf';\n"),
        'node_modules/pnp-leaf/package.json': new TextEncoder().encode(
          JSON.stringify({ name: 'pnp-leaf', exports: { import: './index.mjs', require: './index.cjs' } })
        ),
        'node_modules/pnp-leaf/index.cjs': new TextEncoder().encode('module.exports = { value: 42 };\n'),
        'node_modules/pnp-leaf/index.mjs': new TextEncoder().encode('export const value = 42;\n')
      })
    );
    await fs.writeFile(
      '/home/project/.pnp.data.json',
      JSON.stringify({
        packageRegistryData: [
          [
            null,
            [
              [
                null,
                {
                  packageLocation: './',
                  packageDependencies: [
                    ['pnp-payload', 'file:payload'],
                    ['project', 'workspace:.']
                  ]
                }
              ]
            ]
          ],
          [
            'pnp-payload',
            [
              [
                'file:payload',
                {
                  packageLocation: './.yarn/cache/pnp-graph.zip/node_modules/pnp-payload/',
                  packageDependencies: [
                    ['pnp-payload', 'file:payload'],
                    ['pnp-leaf', 'file:leaf']
                  ]
                }
              ]
            ]
          ],
          [
            'pnp-leaf',
            [
              [
                'file:leaf',
                {
                  packageLocation: './.yarn/cache/pnp-graph.zip/node_modules/pnp-leaf/',
                  packageDependencies: [['pnp-leaf', 'file:leaf']]
                }
              ]
            ]
          ]
        ]
      })
    );

    const payloadRoot = '/home/project/.yarn/cache/pnp-graph.zip/node_modules/pnp-payload';
    expect(() => createModuleResolver(fs, { cwd: '/home/project' }).resolve('pnp-payload', '/home/project/scripts')).toThrow(
      "Cannot find module 'pnp-payload'"
    );
    const resolver = createModuleResolver(fs, { cwd: '/home/project', pnp: true });

    expect(resolver.resolve('pnp-payload', '/home/project/scripts', 'require')).toBe(`${payloadRoot}/index.cjs`);
    expect(resolver.resolve('pnp-payload', '/home/project/scripts', 'import')).toBe(`${payloadRoot}/index.mjs`);
    expect(resolver.resolve('pnp-leaf', payloadRoot, 'require')).toBe(
      '/home/project/.yarn/cache/pnp-graph.zip/node_modules/pnp-leaf/index.cjs'
    );
    expect(fs.readText(`${payloadRoot}/index.cjs`)).toContain("require('pnp-leaf')");
    expect(fs.isDirectory(payloadRoot)).toBe(true);
    expect(await fs.readdir(payloadRoot)).toEqual(['index.cjs', 'index.mjs', 'package.json']);
    expect(() => resolver.resolve('pnp-leaf', '/home/project/scripts', 'require')).toThrow("Cannot find module 'pnp-leaf'");
  });
});

describe('Module Execution Engine resolution cache', () => {
  test('re-resolves through an archive once the commit journal reports it rewritten', () => {
    const fs = new VirtualFileSystem('/home/project');
    const records: VfsCommitJournalRecord[] = [];
    let revision = 0;
    // Commits through the file system's own commit path, so the journal holds what the VFS emits.
    const commit = (...operations: VfsCommitOperation[]) => {
      const applied = fs.applyCommit(operations);
      if (!applied.ok) throw applied.error;
      revision += 1;
      records.push({ revision, invalidations: applied.invalidations });
    };
    const archive = (main: string) =>
      zipSync({
        'pkg/package.json': new TextEncoder().encode(JSON.stringify({ main })),
        'pkg/a.js': new TextEncoder().encode('a'),
        'pkg/b.js': new TextEncoder().encode('b')
      });
    commit({ type: 'mkdir', path: '/home/project/vendor', options: { recursive: true } });
    commit({ type: 'write-file', path: '/home/project/vendor/bundle.zip', data: archive('./a.js') });
    const resolver = createModuleResolver(fs, {
      cwd: '/home/project',
      commitJournal: {
        get revision() {
          return revision;
        },
        readCommitJournal: (afterRevision) => ({
          status: 'delta',
          fromRevision: afterRevision,
          toRevision: revision,
          records: records.filter((record) => record.revision > afterRevision)
        })
      }
    });

    expect(resolver.resolve('./vendor/bundle.zip/pkg', '/home/project', 'require')).toBe(
      '/home/project/vendor/bundle.zip/pkg/a.js'
    );
    commit({ type: 'write-file', path: '/home/project/vendor/bundle.zip', data: archive('./b.js') });
    // Rewriting the archive is a `path` change of the archive alone.
    expect(records.at(-1)?.invalidations.filter((invalidation) => invalidation.scope !== 'directory')).toEqual([
      { path: '/home/project/vendor/bundle.zip', scope: 'path' }
    ]);
    expect(resolver.resolve('./vendor/bundle.zip/pkg', '/home/project', 'require')).toBe(
      '/home/project/vendor/bundle.zip/pkg/b.js'
    );
  });
});

async function writePackage(
  fs: VirtualFileSystem,
  name: string,
  packageFixture: {
    manifest: Record<string, unknown>;
    files: Record<string, string>;
  }
): Promise<void> {
  const root = `/home/project/node_modules/${name}`;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(`${root}/package.json`, JSON.stringify(packageFixture.manifest, null, 2));
  for (const [path, contents] of Object.entries(packageFixture.files)) {
    const directory = path.split('/').slice(0, -1).join('/');
    if (directory) await fs.mkdir(`${root}/${directory}`, { recursive: true });
    await fs.writeFile(`${root}/${path}`, contents);
  }
}
