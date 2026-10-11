import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'tailwind-4-3-3-vite-react',
  statement: 'Tailwind CSS 4.3.3 with @tailwindcss/vite generates utilities for React 19 in Vite 8.3.2 development and in a production build',
  target: npmExactGraph('tailwind-4-vite-react', { tailwindcss: '4.3.3', '@tailwindcss/vite': '4.3.3', react: '19.3.0', vite: '8.3.2' }, 'npm run dev')
});

test.use({ fixture: 'tailwind-4-vite-react' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm run dev', { timeoutMs: 180_000 });
  const app = await server.open('/');
  await expect(app.getByRole('heading', { name: 'Pricing' })).toHaveCSS('font-weight', '700', { timeout: 120_000 });
  await app.getByLabel('Bill yearly').check();
  await expect(app.locator('[data-price]').nth(1)).toContainText('$200');
  await server.stop();
  const build = await stack.run('npm run build', { timeoutMs: 240_000 });
  expect(build.exitCode, build.output).toBe(0);
});
