import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './stack-scenario';

const wsCompatibilityClaim = defineCompatibilityClaim({
  id: 'ws-8-21-0',
  statement:
    'ws 8.21.0 exercises WebSocket framing, backpressure, errors, and lifecycle through a Published Endpoint with an application-owned browser client',
  target: {
    kind: 'exact-graph',
    packages: { ws: '8.21.0' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/ws-8.21.0/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command: 'node', entrypoint: 'server.mjs' }
  }
});

test.use({ fixture: 'ws-8.21.0' });

const expectedExchange = {
  type: 'ws-compatibility-result',
  textMessages: [
    { length: 'fragment-complete'.length, prefix: 'fragment-complete' },
    { length: 'server:browser-client:'.length + 32 * 1024, prefix: 'server:browser-client:' }
  ],
  binaryMessages: [[21, 13, 8, 5]],
  rejectedEvents: ['error', 'close:1006:false'],
  protocol: 'ws-compatibility'
};

test(wsCompatibilityClaim.statement, async ({ stack }) => {
  // The client connects to `/reject` to see the server refuse it.
  stack.expectConsoleError(/\/reject/);
  await stack.install();

  // The server closes itself after one exchange, so the second run restarts it in the same container.
  const urls: string[] = [];
  for (const run of [1, 2]) {
    const server = await stack.start('node server.mjs');
    expect(server.port).toBe(5173);
    expect(new URL(server.url).origin).toBe(new URL(stack.page.url()).origin);
    expect(urls).not.toContain(server.url);
    urls.push(server.url);

    if (run === 1) {
      const vfsMiss = await server.fetch('/vfs-published-endpoint-miss.txt');
      expect(vfsMiss.status).toBe(200);
      expect(vfsMiss.body).toContain('ws connecting');
      expect(vfsMiss.body).not.toContain('this VFS-only marker must never satisfy a ws Published Endpoint request');
    }

    const exchange = stack.waitForMessage('ws-compatibility-result');
    await server.open('/');
    expect(await exchange).toEqual(expectedExchange);
    await server.waitForOutput('http-close ok');
    const { exitCode, output } = await server.exit(10_000);
    expect(exitCode, output).toBe(0);
    expect((await server.fetch('/', { timeoutMs: 2_000 })).status).not.toBe(200);

    expect(output).toContain('ws-upgrade /socket websocket ws-compatibility');
    expect(output).toContain('ws-connection /socket ws-compatibility');
    expect(output).toContain('ws-message browser-client false');
    expect(output).toContain('ws-message 5,8,13,21 true');
    expect(output).toContain('ws-pong health');
    expect(output).toMatch(/ws-backpressure-after-send [1-9]\d*/u);
    const order = ['ws-backpressure-callback ok 0', 'ws-close 1000 done', 'wss-close', 'http-close ok'].map((marker) =>
      output.indexOf(marker)
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    for (const legacy of ['hmr-broker', 'legacy-hmr-broadcast', 'mimic:hmr-client-message', 'mimic:hmr-payload']) {
      expect(output).not.toContain(legacy);
    }
  }
});
