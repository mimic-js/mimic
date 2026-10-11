/**
 * The slice of Babel the Runtime Artifact translator uses (ADR-0023), bundled
 * from Babel's own packages rather than `@babel/standalone`, which carries
 * every preset and plugin Babel publishes (ADR-0034). `transform` accepts the
 * preset and plugin names the translator passes and nothing else; everything
 * else a translator option names reaches `@babel/core` as written.
 */
import './runtime-artifact-compiler-babel-globals';

import { transformSync, version } from '@babel/core';
import * as parser from '@babel/parser';
import transformExportNamespaceFrom from '@babel/plugin-transform-export-namespace-from';
import transformModulesSystemjs from '@babel/plugin-transform-modules-systemjs';
import presetTypescript from '@babel/preset-typescript';

import type { BabelStandalone } from '../module-execution-engine';

const PRESETS: Readonly<Record<string, unknown>> = { typescript: presetTypescript };
const PLUGINS: Readonly<Record<string, unknown>> = {
  'transform-export-namespace-from': transformExportNamespaceFrom,
  'transform-modules-systemjs': transformModulesSystemjs
};

/** A `name` or `[name, options]` entry becomes the bundled module; any other entry is already one. */
function bundled(table: Readonly<Record<string, unknown>>, kind: string, entry: unknown): unknown {
  const name =
    typeof entry === 'string'
      ? entry
      : Array.isArray(entry) && typeof entry[0] === 'string'
        ? entry[0]
        : undefined;
  if (name === undefined) return entry;
  if (!(name in table)) throw new Error(`The compiler does not bundle the Babel ${kind} "${name}".`);
  return typeof entry === 'string' ? table[name] : [table[name], ...(entry as readonly unknown[]).slice(1)];
}

const asEntries = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

export const transform: BabelStandalone['transform'] = (code, options) => {
  const result = transformSync(code, {
    ...options,
    presets: asEntries(options.presets)?.map((preset) => bundled(PRESETS, 'preset', preset)),
    plugins: asEntries(options.plugins)?.map((plugin) => bundled(PLUGINS, 'plugin', plugin))
  });
  return { code: result?.code };
};

export const packages: BabelStandalone['packages'] = { parser };

export { version };
