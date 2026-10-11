import { mkdir, writeFile } from 'node:fs/promises';
import {
  publishedEndpointServiceWorkerAsset,
  publishedEndpointServiceWorkerAssetSource
} from './published-endpoint-service-worker-asset.mjs';
import { buildRuntimeHostAssets } from './runtime-host-assets.ts';

const source = await publishedEndpointServiceWorkerAssetSource();

// `--stdout` prints the Service Worker asset instead of writing it, so the
// unit test can compare the committed file with what this toolchain would
// generate; the prebuilt bundles are not generated then.
if (process.argv.includes('--stdout')) {
  process.stdout.write(source);
} else {
  await mkdir(new URL('./', publishedEndpointServiceWorkerAsset), { recursive: true });
  await writeFile(publishedEndpointServiceWorkerAsset, source);
  await buildRuntimeHostAssets();
}
