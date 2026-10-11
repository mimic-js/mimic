import { bodyParser } from '@koa/bodyparser';
import Router from '@koa/router';
import Koa from 'koa';
import serve from 'koa-static';

const app = new Koa();
const router = new Router({ prefix: '/api/bookmarks' });
const bookmarks = [];

router.get('/', (ctx) => {
  ctx.body = bookmarks;
});

router.post('/', (ctx) => {
  const { url, title } = ctx.request.body ?? {};
  ctx.assert(typeof url === 'string' && URL.canParse(url), 422, 'url must be an absolute URL');
  const bookmark = { id: bookmarks.length + 1, url, title: title ?? new URL(url).hostname };
  bookmarks.push(bookmark);
  ctx.status = 201;
  ctx.body = bookmark;
});

app.use(async (ctx, next) => {
  const startedAt = Date.now();
  await next();
  ctx.set('x-response-time', `${Date.now() - startedAt}ms`);
});
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    ctx.status = error.status ?? 500;
    ctx.body = { error: error.message };
  }
});
app.use(bodyParser());
app.use(router.routes());
app.use(router.allowedMethods());
app.use(serve(new URL('../public', import.meta.url).pathname));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`bookmarks listening on http://localhost:${port}`));
