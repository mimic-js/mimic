import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'sveltekit-3-0-0-guestbook',
  statement: 'SvelteKit 3.0.0 on Vite 8.3.2 serves a server-loaded page, a form action and an endpoint in development',
  target: npmExactGraph('sveltekit-3-guestbook', { '@sveltejs/kit': '3.0.0', svelte: '5.57.1', vite: '8.3.2' }, 'npm run dev')
});

test.use({ fixture: 'sveltekit-3-guestbook' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
  const app = await server.open('/');
  await expect(app.getByRole('listitem')).toHaveText(['Ada: First!'], { timeout: 120_000 });
  await app.getByPlaceholder('Your name').fill('Grace');
  await app.getByPlaceholder('Say something').fill('Hello');
  await app.getByRole('button', { name: 'Sign' }).click();
  await expect(app.getByRole('listitem')).toHaveText(['Ada: First!', 'Grace: Hello']);
  expect(JSON.parse((await server.fetch('/api/entries')).body)).toHaveLength(2);
});
