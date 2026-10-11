import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const workflow = readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageManifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts?: Record<string, string>;
};
const playwrightConfig = readFileSync(new URL('../../playwright.config.ts', import.meta.url), 'utf8');

describe('compatibility CI workflow', () => {
  test('runs the unit contracts without an Architecture Gate', () => {
    const unitJob = job('unit');

    expect(unitJob).toContain('pnpm run test:unit');
    expect(unitJob).not.toContain('architecture:check');
    expect(packageManifest.scripts).not.toHaveProperty('architecture:check');
  });

  test('discovers every co-located Compatibility Claim before required execution', () => {
    const discoveryJob = job('compatibility-matrix');
    const requiredJob = job('compatibility-required');

    expect(packageManifest.scripts?.['compatibility:matrix']).toBe(
      'tsx scripts/compatibility-claim-matrix.ts'
    );
    expect(discoveryJob).toContain(
      "if: github.event_name == 'pull_request' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
    );
    expect(discoveryJob).toContain('pnpm run compatibility:matrix -- --github-output');
    expect(discoveryJob).toContain('fetch-depth: 0');
    expect(discoveryJob).toContain("format('origin/{0}', github.base_ref)");
    expect(discoveryJob).toContain('matrix: ${{ steps.matrix.outputs.matrix }}');
    expect(requiredJob).toContain('needs: [build, unit, compatibility-matrix, compatibility-shard]');
    expect(requiredJob).toContain('Compatibility matrix did not complete successfully');
  });

  test('runs the same bounded parallel matrix on pull requests and nightly validation', () => {
    const shardJob = job('compatibility-shard');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('schedule:');
    expect(shardJob).toContain('fromJSON(needs.compatibility-matrix.outputs.matrix)');
    expect(shardJob).toContain('fail-fast: false');
    expect(shardJob).toContain('max-parallel: 4');
    expect(shardJob).toContain('pnpm exec playwright test ${{ matrix.specs }} --project browser-runtime');
    expect(shardJob).toContain('Compatibility Claims in this shard');
    expect(shardJob).toContain('name: playwright-report-${{ matrix.shard }}');
    expect(shardJob).toContain('playwright-report/');
    expect(shardJob).toContain('test-results/');
    expect(shardJob).not.toContain('COMPATIBILITY_RECEIPT_ARTIFACT_DIR');
    expect(shardJob).not.toContain('compatibility-artifacts');
    expect(shardJob).not.toContain('SUSPEND_FROZEN_NPM_EVIDENCE');
  });

  test('warms the tarball cache for every shard and proves frozen installs on the nightly run', () => {
    const shardJob = job('compatibility-shard');

    expect(packageManifest.scripts?.['compatibility:prefetch']).toBe('tsx scripts/prefetch-compatibility-tarballs.ts');
    expect(shardJob).toContain('uses: actions/cache@v4');
    expect(shardJob).toContain('path: packages/runtime/.cache');
    expect(shardJob.indexOf('pnpm run compatibility:prefetch')).toBeLessThan(shardJob.indexOf('pnpm exec playwright test'));
    expect(shardJob).toContain("COMPATIBILITY_INSTALL_LAYERS: ${{ github.event_name == 'schedule' && '0' || '1' }}");
  });

  test('removes representative-only and scheduled-only compatibility lanes', () => {
    expect(workflow).not.toContain('compatibility-pull-request:');
    expect(workflow).not.toContain('compatibility-main:');
    expect(workflow).not.toContain('compatibility-nightly:');
    expect(workflow).not.toContain('pnpm run test:e2e');
    expect(workflow).not.toContain('compatibility-main-receipts:');
    expect(workflow).not.toContain('compatibility-main-report:');
    expect(workflow).not.toContain('compatibility:merge-receipts');
    expect(workflow).not.toContain('COMPATIBILITY_RECEIPT_ARTIFACT_DIR');
    expect(workflow).not.toContain('compatibility-artifacts');
    expect(workflow).not.toContain('SUSPEND_FROZEN_NPM_EVIDENCE');
    expect(packageManifest.scripts).not.toHaveProperty('compatibility:merge-receipts');
    expect(playwrightConfig).not.toContain('SUSPEND_FROZEN_NPM_EVIDENCE');
    expect(playwrightConfig).not.toContain('testIgnore:');
  });
});

function job(name: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  expect(start, `missing CI job ${name}`).toBeGreaterThanOrEqual(0);

  const followingWorkflow = workflow.slice(start + 1);
  const nextJobOffset = followingWorkflow.search(/\n  [a-z][a-z0-9-]*:\n/);
  return nextJobOffset === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + nextJobOffset);
}
