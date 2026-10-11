import { describe, expect, test, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as Array<{ env: Record<string, string> }>);

vi.mock('../../src/runtime/modules/runtime-host', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/runtime/modules/runtime-host')>();
  return {
    ...original,
    bootRuntimeHost: async () => ({
      fs: {},
      endpoints: {},
      spawn: async (request: { env: Record<string, string> }) => {
        spawned.push(request);
        return {};
      },
      teardown: async () => undefined
    })
  };
});

const { Mimic } = await import('../../src/runtime/index');

describe('Mimic.spawn environment', () => {
  test('skips the browser downloads of puppeteer and Cypress unless the caller sets them', async () => {
    const container = await Mimic.boot();

    await container.spawn('npm', ['install']);
    await container.spawn('npm', ['install'], {
      env: { PUPPETEER_SKIP_DOWNLOAD: '', CYPRESS_INSTALL_BINARY: '13.6.0' }
    });

    expect(spawned[0]!.env).toMatchObject({
      HOME: '/home/browser',
      PATH: '/home/project/node_modules/.bin:/bin',
      PUPPETEER_SKIP_DOWNLOAD: '1',
      CYPRESS_INSTALL_BINARY: '0'
    });
    expect(spawned[1]!.env).toMatchObject({
      PUPPETEER_SKIP_DOWNLOAD: '',
      CYPRESS_INSTALL_BINARY: '13.6.0'
    });
  });
});
