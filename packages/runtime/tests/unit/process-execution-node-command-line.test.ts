import { describe, expect, test } from 'vitest';

import {
  parseNodeCommandLine,
  type NodeCommandLine
} from '../../src/runtime/modules/process-execution/node-command-line';
import { resolveInlineNodeEntry } from '../../src/runtime/modules/process-execution/executable-resolution';

function parsed(args: readonly string[]): NodeCommandLine {
  const result = parseNodeCommandLine(args);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe('node command line option table', () => {
  test('separates options, the entry, and application arguments', () => {
    const commandLine = parsed([
      '-r',
      './a.cjs',
      '--import=./b.mjs',
      '-C',
      'development',
      '--max-old-space-size=4096',
      '--title',
      'tool',
      '--no-warnings',
      'entry.js',
      '--watch',
      '-p'
    ]);

    expect(commandLine.action).toEqual({ kind: 'run', entry: 'entry.js' });
    expect(commandLine.applicationArgs).toEqual(['--watch', '-p']);
    expect(commandLine.execArgv).toEqual([
      '-r',
      './a.cjs',
      '--import=./b.mjs',
      '-C',
      'development',
      '--max-old-space-size=4096',
      '--title',
      'tool',
      '--no-warnings'
    ]);
    expect(commandLine.preloads).toEqual({ require: ['./a.cjs'], import: ['./b.mjs'] });
    expect(commandLine.conditions).toEqual(['development']);
    expect(commandLine.values.get('--title')).toBe('tool');
    expect([...commandLine.flags]).toEqual(['--no-warnings']);
  });

  test('a later flag replaces its negation', () => {
    expect([...parsed(['--no-warnings', '--warnings', 'a.js']).flags]).toEqual(['--warnings']);
    expect([...parsed(['--deprecation', '--no-deprecation', 'a.js']).flags]).toEqual(['--no-deprecation']);
  });

  test.each([
    { args: ['-v'], action: { kind: 'version' } },
    { args: ['--help', 'ignored.js'], action: { kind: 'help' } },
    { args: [], action: { kind: 'none' } },
    { args: ['--', '-entry.js'], action: { kind: 'run', entry: '-entry.js' } },
    { args: ['-e', 'x'], action: { kind: 'eval', source: 'x', print: false } },
    { args: ['--eval=x'], action: { kind: 'eval', source: 'x', print: false } },
    { args: ['-p', 'x'], action: { kind: 'eval', source: 'x', print: true } },
    { args: ['-pe', 'x'], action: { kind: 'eval', source: 'x', print: true } },
    { args: ['--print', '--eval', 'x'], action: { kind: 'eval', source: 'x', print: true } }
  ])('reads $args as $action.kind', ({ args, action }) => {
    expect(parsed(args).action).toEqual(action);
  });

  test.each([
    { args: ['--bogus'], message: 'node: bad option: --bogus' },
    { args: ['--bogus=1', 'a.js'], message: 'node: bad option: --bogus=1' },
    { args: ['-z'], message: 'node: bad option: -z' },
    { args: ['--no-eval', 'a.js'], message: 'node: bad option: --no-eval' },
    { args: ['--version=1'], message: 'node: bad option: --version=1' },
    { args: ['--require'], message: 'node: --require requires an argument' },
    { args: ['--conditions='], message: 'node: --conditions requires an argument' },
    { args: ['-p'], message: 'node: -p requires an argument' },
    { args: ['--check', 'a.js'], message: 'node: --check is not supported in Mimic' }
  ])('rejects $args with exit code 9', ({ args, message }) => {
    expect(parseNodeCommandLine(args)).toMatchObject({ ok: false, message, exitCode: 9 });
  });

  test('inline-entry resolution reads the same table', () => {
    const resolution = resolveInlineNodeEntry([
      '--max-old-space-size=64',
      '--input-type=module',
      '-C',
      'custom',
      '-e',
      'source',
      '--no-warnings',
      '--',
      '--application-flag'
    ]);

    expect(resolution).toEqual({
      ok: true,
      value: {
        source: 'source',
        applicationArgs: ['--application-flag'],
        execArgv: ['--max-old-space-size=64', '--input-type=module', '-C', 'custom', '-e', 'source', '--no-warnings'],
        preloadArgv: ['--max-old-space-size=64', '--input-type=module', '-C', 'custom', '--no-warnings'],
        inputType: 'module'
      }
    });
    expect(resolveInlineNodeEntry(['-p', '1 + 1'])).toMatchObject({ ok: true, value: { source: '1 + 1', print: true } });
    expect(resolveInlineNodeEntry(['--max-old-space-size=64', 'entry.js'])).toBeUndefined();
    // A command line that is malformed elsewhere is the node Runtime Program's to report.
    expect(resolveInlineNodeEntry(['--bogus', '-e', 'source'])).toBeUndefined();
    expect(resolveInlineNodeEntry(['-e'])).toEqual({ ok: false, message: 'node: -e requires an argument' });
  });
});
