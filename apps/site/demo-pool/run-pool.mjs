// Runs each application of the demo pool in the repository playground, one
// after another: opens ?repo=&ref=, types the setup and dev commands into the
// playground's terminal, and reads the preview the dev server publishes.
//
// usage: node run-pool.mjs <pool.json> <out-dir> [id-filter-regex]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const require = createRequire('/home/user/web-containers-clone/packages/runtime/package.json');
const { chromium } = require('@playwright/test');

const [poolPath, outDir, filter] = process.argv.slice(2);
const PLAYGROUND = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5173';
const pool = JSON.parse(readFileSync(poolPath, 'utf8')).apps;
for (const sub of ['results', 'logs', 'shots']) mkdirSync(`${outDir}/${sub}`, { recursive: true });

const MOUNT_TIMEOUT = 6 * 60_000;
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT ?? 20 * 60_000);
const ENDPOINT_TIMEOUT = Number(process.env.ENDPOINT_TIMEOUT ?? 10 * 60_000);
const RENDER_TIMEOUT = 3 * 60_000;
const SETTLE_MS = 8_000;

// Pages a dev server shows while its first build still runs.
const LOADING = /building development bundle|preparing requested page|compiling|loading\.\.\.|^loading$|step \d+\/\d+/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // The playground and its per-port preview origins (*.localhost) are this machine's.
  proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost,*.localhost' },
  args: ['--ignore-certificate-errors']
});

for (const app of pool) {
  if (filter && !new RegExp(filter).test(app.id)) continue;
  if (process.env.SKIP_DONE && existsSync(`${outDir}/results/${app.id}.json`)) continue;
  const started = Date.now();
  console.log(`\n=== ${app.id} (${app.repo}@${app.ref ?? 'HEAD'}${app.dir ? ` ${app.dir}` : ''})`);
  let result;
  try {
    result = await runApp(app);
  } catch (error) {
    result = { status: 'harness-error', reason: String(error?.stack ?? error) };
  }
  result = { id: app.id, ...result, seconds: Math.round((Date.now() - started) / 1000) };
  writeFileSync(`${outDir}/results/${app.id}.json`, JSON.stringify(result, null, 2));
  console.log(`--> ${result.status} in ${result.seconds}s${result.reason ? `: ${String(result.reason).slice(0, 300)}` : ''}`);
}
await Promise.race([browser.close(), sleep(10_000)]);
process.exit(0);

async function runApp(app) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    try {
      // Errors of the preview document, whose URL is under the endpoints
      // directory or on an endpoint's own origin, `<epoch>--<port>.…` (ADR-0044).
      if (message.type() === 'error' && /__mimic__|\/\/[^/]+--\d+\.|\/home\/project\//.test(message.location()?.url ?? '')) {
        consoleErrors.push(message.text().slice(0, 500));
      }
    } catch {}
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 500)}`));
  process.on('uncaughtException', (error) => console.error('uncaught', error));
  // Exposes the terminal and its container to the harness, with a scrollback
  // long enough for an install's output.
  await page.route('**/src/Terminals.tsx*', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('new Terminal({', 'new Terminal({ scrollback: 200000,')
      .replace('terminalRef.current = terminal;', 'terminalRef.current = terminal; window.__pg = { terminal, container };');
    await route.fulfill({ response, body });
  });

  const timings = {};
  const log = () => terminalText(page).catch(() => '');
  const finish = async (fields) => {
    const text = await log();
    writeFileSync(`${outDir}/logs/${app.id}.log`, text);
    await page.screenshot({ path: `${outDir}/shots/${app.id}.png` }).catch(() => undefined);
    await Promise.race([context.close().catch(() => undefined), sleep(15_000)]);
    return { timings, consoleErrors: [...new Set(consoleErrors)].slice(0, 15), ...fields };
  };

  try {
    const search = new URLSearchParams({ repo: app.repo, ...(app.ref ? { ref: app.ref } : {}) });
    let t = Date.now();
    await page.goto(`${PLAYGROUND}/playground?${search}`);
    const outcome = await Promise.race([
      page.locator('.workspace').waitFor({ timeout: MOUNT_TIMEOUT }).then(() => 'ready'),
      page.locator('[data-phase="failed"]').waitFor({ timeout: MOUNT_TIMEOUT }).then(() => 'failed')
    ]);
    if (outcome === 'failed') {
      return finish({ status: 'download-failed', reason: await page.locator('[data-phase="failed"]').innerText() });
    }
    await page.waitForFunction(() => window.__pg, null, { timeout: 60_000 });
    timings.mount = Math.round((Date.now() - t) / 1000);

    if (app.dir) await type(page, `cd ${app.dir}`);
    for (const [index, step] of (app.setup ?? []).entries()) {
      t = Date.now();
      if (/^cd\s/.test(step)) {
        await type(page, step);
        continue;
      }
      const code = await runStep(page, step, index, STEP_TIMEOUT);
      timings[`step${index}`] = Math.round((Date.now() - t) / 1000);
      if (code === undefined) return finish({ status: 'setup-timeout', step, reason: tail(await log()) });
      if (code !== 0) return finish({ status: 'setup-failed', step, exitCode: code, reason: tail(await log()) });
    }

    t = Date.now();
    const devIndex = (app.setup ?? []).length;
    await type(page, `${app.dev}; echo @@D""ONE${devIndex}=$?`);
    const endpoint = await Promise.race([
      page.locator('.preview iframe').waitFor({ timeout: ENDPOINT_TIMEOUT }).then(() => 'published'),
      waitForMarker(page, devIndex, ENDPOINT_TIMEOUT).then((code) => (code === undefined ? 'timeout' : `exited:${code}`))
    ]);
    timings.devStart = Math.round((Date.now() - t) / 1000);
    if (endpoint !== 'published') {
      return finish({ status: endpoint === 'timeout' ? 'dev-no-endpoint' : 'dev-exited', reason: tail(await log()) });
    }
    // A dev server may publish before it is ready to answer; let it settle.
    t = Date.now();
    const verdict = await readPreview(page, app);
    timings.render = Math.round((Date.now() - t) / 1000);
    return finish(verdict);
  } catch (error) {
    return finish({ status: 'harness-error', reason: String(error?.message ?? error).slice(0, 2000) });
  }
}

async function type(page, line) {
  await page.evaluate((text) => window.__pg.terminal.input(`${text}\r`, true), line);
  await sleep(300);
}

async function runStep(page, step, index, timeout) {
  await type(page, `${step}; echo @@D""ONE${index}=$?`);
  return waitForMarker(page, index, timeout);
}

async function waitForMarker(page, index, timeout) {
  const deadline = Date.now() + timeout;
  const pattern = new RegExp(`@@DONE${index}=(-?\\d+)`);
  while (Date.now() < deadline) {
    const match = pattern.exec(await terminalText(page).catch(() => ''));
    if (match) return Number(match[1]);
    await sleep(2000);
  }
  return undefined;
}

function terminalText(page) {
  return page.evaluate(() => {
    const buffer = window.__pg.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n').replace(/\n+$/, '');
  });
}

function tail(text, lines = 40) {
  return text.split('\n').slice(-lines).join('\n');
}

/** Waits for the preview document to render, and classifies what it shows. */
async function readPreview(page, app) {
  const deadline = Date.now() + RENDER_TIMEOUT;
  let last = { state: 'no-frame' };
  let reloaded = false;
  let contentSince;
  while (Date.now() < deadline) {
    const handle = await page.locator('.preview iframe').elementHandle().catch(() => null);
    const frame = await handle?.contentFrame().catch(() => null);
    if (frame) {
      last = await frame
        .evaluate(() => {
          const overlay =
            document.querySelector('vite-error-overlay') ??
            document.querySelector('#webpack-dev-server-client-overlay') ??
            document.querySelector('nextjs-portal') ??
            document.querySelector('#react-refresh-overlay');
          let overlayText = '';
          if (overlay) {
            const root = overlay.shadowRoot ?? overlay.contentDocument?.body ?? overlay;
            overlayText = (root.textContent ?? '').trim().slice(0, 1500);
          }
          const body = document.body;
          const text = (body?.innerText ?? '').trim();
          const visual = [...(body?.querySelectorAll('img,svg,canvas,video,input,button') ?? [])].filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          }).length;
          return { state: 'loaded', url: location.href, title: document.title, text: text.slice(0, 400), textLength: text.length, visual, overlay: overlay ? overlay.tagName.toLowerCase() || overlay.id : null, overlayText };
        })
        .catch((error) => ({ state: 'frame-error', error: String(error).slice(0, 300) }));
      const loading = last.state === 'loaded' && LOADING.test(last.text) && last.textLength < 300;
      const hasContent = !loading && last.state === 'loaded' && (last.textLength > 0 || last.visual > 0);
      if (last.overlay && last.overlayText) {
        // Next's portal exists without an error; only a dialog in it is one.
        if (last.overlay !== 'nextjs-portal' || /error|failed/i.test(last.overlayText)) break;
      }
      if (hasContent) {
        contentSince ??= Date.now();
        if (Date.now() - contentSince > SETTLE_MS) break;
      } else {
        contentSince = undefined;
      }
      // A first request can race the server's start; reload once halfway.
      if (!reloaded && Date.now() > deadline - RENDER_TIMEOUT / 2 && !hasContent) {
        reloaded = true;
        await page.getByRole('button', { name: 'Reload' }).click().catch(() => undefined);
      }
    }
    await sleep(2000);
  }
  await page.locator('.preview').screenshot({ path: `${outDir}/shots/${app.id}.preview.png` }).catch(() => undefined);
  const hasContent = last.state === 'loaded' && (last.textLength > 0 || last.visual > 0) && !(LOADING.test(last.text) && last.textLength < 300);
  if (last.overlay && last.overlayText && (last.overlay !== 'nextjs-portal' || /error|failed/i.test(last.overlayText))) {
    return { status: 'error-overlay', preview: last, reason: last.overlayText.slice(0, 800) };
  }
  if (last.state === 'loaded' && last.url.startsWith('chrome-error:')) {
    return { status: 'navigation-error', preview: last, reason: 'the preview document failed to load (Chromium error page)' };
  }
  if (!hasContent) return { status: 'blank-preview', preview: last, reason: last.error ?? 'the preview stayed empty' };
  const suspicious = /cannot get|not found|internal server error|^error|404|500|failed to (load|fetch|compile)|unexpected|exception|is not defined|is not a function/i.test(last.text) && last.textLength < 1500;
  return { status: suspicious ? 'error-page' : 'pass', preview: last, ...(suspicious ? { reason: last.text } : {}) };
}
