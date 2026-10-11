import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const cryptoCompressionDataUtilitiesClaim = defineCompatibilityClaim({
  id: 'node-crypto-compression-data-utilities-v1',
  statement: 'Mimic executes browser-feasible Node crypto, compression, buffer, and encoding utilities',
  target: {
    kind: 'runtime-capability',
    capability: 'node-crypto-compression-data-utilities'
  }
});

const forbiddenFallbacks = ['falling back to registered command adapter', 'esm.sh', 'vfsPreviewFallback'] as const;

test(cryptoCompressionDataUtilitiesClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/crypto-compression-data-utilities' });

    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const crypto = require('crypto');",
              "const nodeCrypto = require('node:crypto');",
              "const zlib = require('zlib');",
              "const nodeZlib = require('node:zlib');",
              "const buffer = require('buffer');",
              "const nodeBuffer = require('node:buffer');",
              "const stringDecoder = require('string_decoder');",
              "const nodeStringDecoder = require('node:string_decoder');",
              '(async () => {',
              "  const payload = buffer.Buffer.from('mimic compression payload', 'utf8');",
              "  const incrementalHash = crypto.createHash('sha256').update('browser-').update('container').digest('hex');",
              "  const oneShotHash = crypto.hash('sha256', 'mimic', 'hex');",
              '  const randomBytes = crypto.randomBytes(24);',
              '  const randomValues = new Uint8Array(16);',
              '  const returnedRandomValues = crypto.getRandomValues(randomValues);',
              '  const fillTarget = buffer.Buffer.alloc(18, 0x5a);',
              '  const returnedFillTarget = crypto.randomFillSync(fillTarget, 1, 16);',
              '  const typedFillTarget = new Uint16Array(4);',
              '  const returnedTypedFillTarget = crypto.randomFillSync(typedFillTarget, 1, 2);',
              '  const sharedUtf8 = new SharedArrayBuffer(3);',
              '  new Uint8Array(sharedUtf8).set([0xe2, 0x82, 0xac]);',
              '  const sharedUtf8Valid = buffer.isUtf8(sharedUtf8);',
              '  const returnedSharedFill = crypto.randomFillSync(sharedUtf8);',
              '  let lengthMismatchCode;',
              '  try { crypto.timingSafeEqual(buffer.Buffer.alloc(1), buffer.Buffer.alloc(2)); } catch (error) { lengthMismatchCode = error.code; }',
              '  const uuid = crypto.randomUUID();',
              '  const gzip = zlib.gzipSync(payload);',
              '  const deflate = zlib.deflateSync(payload);',
              '  const hex = buffer.Buffer.from([0, 255, 16]).toString("hex");',
              '  const base64url = buffer.Buffer.from("hello-world").toString("base64url");',
              '  const decodedBase64url = buffer.Buffer.from(base64url, "base64url").toString();',
              '  const boundedTarget = buffer.Buffer.alloc(5);',
              '  const copied = buffer.Buffer.from("browser").copy(boundedTarget, 0, 1, 6);',
              '  const euro = buffer.Buffer.from("€");',
              '  const decoder = new stringDecoder.StringDecoder("utf8");',
              '  const splitPrefix = decoder.write(euro.subarray(0, 1));',
              '  const splitSuffix = decoder.end(euro.subarray(1));',
              '  console.log(JSON.stringify({',
              '    importIdentity: crypto === nodeCrypto && zlib === nodeZlib && buffer === nodeBuffer && stringDecoder === nodeStringDecoder,',
              '    defaultIdentity: crypto.default.createHash === crypto.createHash && zlib.default.gzipSync === zlib.gzipSync && buffer.default.Buffer === buffer.Buffer && stringDecoder.default.StringDecoder === stringDecoder.StringDecoder,',
              '    incrementalHash,',
              '    oneShotHash,',
              '    randomBytesAreBuffer: buffer.Buffer.isBuffer(randomBytes) && randomBytes.byteLength === 24,',
              '    randomValuesIdentity: returnedRandomValues === randomValues && randomValues.byteLength === 16,',
              '    randomFillRange: returnedFillTarget === fillTarget && fillTarget[0] === 0x5a && fillTarget[17] === 0x5a && fillTarget.subarray(1, 17).some((byte) => byte !== 0x5a),',
              '    typedRandomFillRange: returnedTypedFillTarget === typedFillTarget && new Uint8Array(typedFillTarget.buffer).slice(0, 2).every((byte) => byte === 0) && new Uint8Array(typedFillTarget.buffer).slice(6).every((byte) => byte === 0) && new Uint8Array(typedFillTarget.buffer).slice(2, 6).some((byte) => byte !== 0),',
              '    sharedArrayBufferSupport: sharedUtf8Valid && returnedSharedFill === sharedUtf8 && crypto.timingSafeEqual(sharedUtf8, sharedUtf8),',
              '    timingSafeEqual: crypto.timingSafeEqual(buffer.Buffer.from("same"), buffer.Buffer.from("same")) && !crypto.timingSafeEqual(buffer.Buffer.from("same"), buffer.Buffer.from("diff")),',
              '    lengthMismatchCode,',
              '    uuidIsVersion4: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid),',
              '    gzipHeader: [gzip[0], gzip[1]],',
              '    gzipWasCompressed: gzip.toString("base64") !== payload.toString("base64"),',
              '    gzipRoundtrip: zlib.gunzipSync(gzip).toString(),',
              '    deflateWasCompressed: deflate.toString("base64") !== payload.toString("base64"),',
              '    deflateRoundtrip: zlib.inflateSync(deflate).toString(),',
              '    hex,',
              '    base64url,',
              '    decodedBase64url,',
              '    copied,',
              '    boundedTarget: boundedTarget.toString(),',
              '    splitPrefix,',
              '    splitSuffix,',
              '    utf8Validation: buffer.isUtf8(buffer.Buffer.from("valid € 😀")) && !buffer.isUtf8(buffer.Buffer.from([0xc0, 0xaf]))',
              '  }));',
              '})().catch((error) => { console.error(error); process.exitCode = 1; });'
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/crypto-compression-data-utilities/entry.cjs']);
      const output = await collectOutput(process.output);
      return { exitCode: await process.exit, output };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }
  });

  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output.trim().split('\n').at(-1) ?? '')).toEqual({
    importIdentity: true,
    defaultIdentity: true,
    incrementalHash: 'fa13a0ddac261fd7ae833cdea755d640f5844f3039750e4c29fe672c547b2597',
    oneShotHash: 'fa13a0ddac261fd7ae833cdea755d640f5844f3039750e4c29fe672c547b2597',
    randomBytesAreBuffer: true,
    randomValuesIdentity: true,
    randomFillRange: true,
    typedRandomFillRange: true,
    sharedArrayBufferSupport: true,
    timingSafeEqual: true,
    lengthMismatchCode: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH',
    uuidIsVersion4: true,
    gzipHeader: [31, 139],
    gzipWasCompressed: true,
    gzipRoundtrip: 'mimic compression payload',
    deflateWasCompressed: true,
    deflateRoundtrip: 'mimic compression payload',
    hex: '00ff10',
    base64url: 'aGVsbG8td29ybGQ',
    decodedBase64url: 'hello-world',
    copied: 5,
    boundedTarget: 'rowse',
    splitPrefix: '',
    splitSuffix: '€',
    utf8Validation: true
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const fallbackEvidence = [result.output, ...consoleErrors, ...pageErrors].join('\n');
  for (const forbidden of forbiddenFallbacks) {
    expect(fallbackEvidence, `forbidden fallback ${forbidden}`).not.toContain(forbidden);
  }
});
