import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'express-5-2-1-ejs-blog',
  statement: 'Express 5.2.1 renders EJS 6 views with sessions, form posts and a multer multipart upload',
  target: npmExactGraph('express-5-ejs-blog', { express: '5.2.1', ejs: '6.0.1', 'express-session': '1.19.0', multer: '2.4.0', helmet: '8.3.0', compression: '1.8.2' }, 'npm start')
});

test.use({ fixture: 'express-5-ejs-blog' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');
  const app = await server.open('/');
  await expect(app.getByRole('heading', { name: 'Hello world' })).toBeVisible();
  await app.getByPlaceholder('Username').fill('ada');
  await app.getByRole('button', { name: 'Sign in' }).click();
  await expect(app.locator('#greeting')).toHaveText('Signed in as ada');
  await app.getByPlaceholder('Title').fill('Second post');
  await app.getByPlaceholder('Body').fill('Written through a form.');
  await app.getByRole('button', { name: 'Publish' }).click();
  await expect(app.getByRole('heading', { name: 'Second post' })).toBeVisible();
  // A request is routed by the document that makes it: the served application's.
  const upload = await app.locator('body').evaluate(async (body, url) => {
    const win = body.ownerDocument.defaultView;
    if (!win) throw new Error('The served application has no window.');
    const form = new win.FormData();
    form.set('note', 'a note');
    form.set('attachment', new win.File(['file-bytes'], 'a.txt', { type: 'text/plain' }));
    const response = await win.fetch(new URL('upload', url), { method: 'POST', body: form });
    return { status: response.status, body: await response.text() };
  }, server.url);
  expect(upload, await server.output()).toEqual({ status: 200, body: '{"name":"a.txt","size":10,"note":"a note"}' });
});
