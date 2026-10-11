import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'astro-7-3-5-blog',
  statement:
    'Astro 7.3.5 serves pages and Markdown posts in development, follows a root-relative link between them, and builds a static site',
  target: npmExactGraph('astro-7-blog', { astro: '7.3.5' }, 'npm run dev')
});

test.use({ fixture: 'astro-7-blog' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
  const app = await server.open('/');
  await expect(app.getByRole('heading', { name: 'Latest posts' })).toBeVisible({ timeout: 120_000 });
  await app.getByRole('link', { name: 'First post' }).click();
  await expect(app.getByRole('heading', { name: 'First post' })).toBeVisible();
  await server.stop();
  const build = await stack.run('npm run build', { timeoutMs: 240_000 });
  expect(build.exitCode, build.output).toBe(0);
  expect(await stack.readFile('dist/index.html')).toContain('Latest posts');
});
