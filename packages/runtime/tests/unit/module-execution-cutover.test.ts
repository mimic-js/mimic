import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const runtimeRoot = 'src/runtime';
const compilerRoot = 'src/runtime/modules/module-execution-engine/runtime-artifact-compiler';

describe('Module Execution Engine cutover', () => {
  test('deletes the module-loader bridge and its legacy contracts', () => {
    const nodeRunner = readFileSync(
      'src/runtime/modules/node-compatibility/node-runtime-program.ts',
      'utf8'
    );
    const packageManifest = readFileSync('package.json', 'utf8');

    expect(existsSync('src/runtime/module-loader.ts')).toBe(false);
    expect(existsSync('src/runtime/module-loader-runtime-services.ts')).toBe(false);
    expect(
      readFileSync(
        'src/runtime/modules/node-compatibility/execution-context-runtime-services.ts',
        'utf8'
      )
    ).not.toMatch(/preview|vite|dev-server/i);
    expect(existsSync('architecture/module-loader-migration-bridge.cjs')).toBe(false);
    expect(nodeRunner).not.toContain("from './module-loader'");
    expect(nodeRunner).not.toContain('JsModuleLoader');
    expect(nodeRunner).toContain('.engine.runEntry(');
    expect(packageManifest).not.toContain('architecture/module-loader-migration-bridge.cjs');
  });

  test('keeps production dynamic source evaluation inside the Runtime Artifact Compiler', () => {
    const violations = sourceFiles(runtimeRoot)
      .filter((path) => !path.startsWith(`${compilerRoot}/`))
      .filter((path) => /\bnew Function\b|\bAsyncFunction\b|\beval\s*\(/u.test(readFileSync(path, 'utf8')));

    expect(violations).toEqual([]);
  });

  test('deletes the Catalog module-API adapter and package-specific execution prohibition', () => {
    const executionContext = readFileSync(
      'src/runtime/modules/node-compatibility/execution-context-runtime.ts',
      'utf8'
    );

    expect(existsSync(
      'src/runtime/modules/execution-context-bootstrap/catalog-runtime-artifact-adapter.ts'
    )).toBe(false);
    expect(existsSync(
      'src/runtime/modules/execution-context-bootstrap/catalog-runtime-artifact-vfs.ts'
    )).toBe(false);
    expect(executionContext).not.toContain('evaluateCatalogRuntimeArtifact');
    expect(executionContext).not.toContain('packageRuntimeBoundary');
    expect(executionContext).not.toMatch(/esbuild|fsevents|node_modules\//i);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith('.ts'));
}
