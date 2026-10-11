import { expect, test } from './stack-scenario';

// Exploratory runs of mainstream stacks that have no Compatibility Claim yet.
// A probe that passes is ready to become a claim; one that fails names a gap.
// They run only on request: STACK_PROBES=1 playwright test tests/e2e/stack-probes.spec.ts
test.skip(!process.env.STACK_PROBES, 'stack probes run only with STACK_PROBES=1');

test.describe('Next.js 16', () => {
  test.use({ fixture: 'next-16-app-router' });
  test('serves an App Router page and a route handler in development', async ({ stack }) => {
    await stack.install();
    const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
    const app = await server.open('/');
    await expect(app.getByRole('heading', { name: 'Hello from Next.js' })).toBeVisible({ timeout: 120_000 });
    await app.getByRole('button').click();
    await expect(app.getByRole('button')).toHaveText('Clicked 1 times');
    expect(JSON.parse((await server.fetch('/api/hello')).body)).toEqual({ message: 'Hello from a route handler' });
  });
});

// Next 14 reaches its SWC WebAssembly build only under `process.versions.webcontainer` (ADR-0045).
test.describe('Next.js 14', () => {
  test.use({ fixture: 'next-14-app-router' });
  test('serves an App Router page and a route handler in development', async ({ stack }) => {
    await stack.install();
    const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
    const app = await server.open('/');
    await expect(app.getByRole('heading', { name: 'Hello from Next.js' })).toBeVisible({ timeout: 120_000 });
    // The server-rendered button answers clicks once the client bundle, compiled on demand, has hydrated it.
    await expect(async () => {
      await app.getByRole('button').click();
      await expect(app.getByRole('button')).toHaveText(/Clicked [1-9]\d* times/, { timeout: 2_000 });
    }).toPass({ timeout: 120_000 });
    expect(JSON.parse((await server.fetch('/api/hello')).body)).toEqual({ message: 'Hello from a route handler' });
  });
});

test.describe('Nuxt 4', () => {
  test.use({ fixture: 'nuxt-4-starter' });
  test('serves a page and a Nitro API route in development', async ({ stack }) => {
    await stack.install();
    const server = await stack.start('npm run dev', { timeoutMs: 240_000 });
    const app = await server.open('/');
    await expect(app.getByRole('heading', { name: 'Hello from Nitro' })).toBeVisible({ timeout: 180_000 });
    await app.getByRole('button').click();
    await expect(app.getByRole('button')).toHaveText('Clicked 1 times');
  });
});

test.describe('React Router 7 framework mode', () => {
  test.use({ fixture: 'react-router-7-framework' });
  test('serves loaders and client navigation in development', async ({ stack }) => {
    await stack.install();
    const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
    const app = await server.open('/');
    await expect(app.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 120_000 });
    await app.getByRole('link', { name: 'Ada Lovelace' }).click();
    await expect(app.getByText('ada@example.com')).toBeVisible();
  });
});

test.describe('Drizzle ORM on better-sqlite3', () => {
  test.use({ fixture: 'drizzle-sqlite-inventory' });
  test('persists rows through a native SQLite driver', async ({ stack }) => {
    await stack.install();
    const server = await stack.start('npm start');
    const created = await server.fetch('/products', { method: 'POST', json: { name: 'Kettle', stock: 2 } });
    expect(created.status, await server.output()).toBe(201);
    const restocked = await server.fetch('/products/1/restock', { method: 'POST', json: { amount: 3 } });
    expect(JSON.parse(restocked.body)).toEqual({ id: 1, name: 'Kettle', stock: 5 });
  });
});

test.describe('node:sqlite', () => {
  test.use({ fixture: 'node-sqlite-builtin' });
  test('runs the built-in SQLite module', async ({ stack }) => {
    const result = await stack.run('npm start');
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('[{"path":"/","hits":2},{"path":"/pricing","hits":1}]');
  });
});

test.describe('Prisma 7', () => {
  test.use({ fixture: 'prisma-7-sqlite-notes' });
  test('generates a client from a schema', async ({ stack }) => {
    await stack.install();
    const generate = await stack.run('npm run generate', { timeoutMs: 240_000 });
    expect(generate.exitCode, generate.output).toBe(0);
    const result = await stack.run('npm start');
    expect(result.output).toContain('client ready function');
  });
});
