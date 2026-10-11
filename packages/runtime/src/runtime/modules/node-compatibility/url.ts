import './port-dependencies/provide';
import { format, parse, resolve, resolveObject, Url } from 'url/url.js';
import { normalizePath } from '../virtual-file-system';

/**
 * `node:url`. `URL` and `URLSearchParams` are the platform's. The legacy API
 * (`parse`, `format`, `resolve`, `resolveObject`, `Url`) is the `url` port of
 * Node's `lib/url.js`, which reads and writes queries with `node:querystring`
 * as Node's does (ADR-0026). `format` of a WHATWG `URL` is its serialization.
 */
export function createUrlBuiltin(cwd: () => string = () => '/'): unknown {
  const url = {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    Url,
    fileURLToPath,
    format: (value: string | object) => (value instanceof URL ? value.href : format(value)),
    parse,
    pathToFileURL: (path: string) => pathToFileURL(path, cwd),
    resolve,
    resolveObject
  };
  return { ...url, default: url };
}

function fileURLToPath(value: string | URL): string {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== 'file:') {
    throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
  }
  if (url.hostname !== '' && url.hostname !== 'localhost') {
    throw Object.assign(new TypeError('File URL host must be "localhost" or empty on linux'), {
      code: 'ERR_INVALID_FILE_URL_HOST'
    });
  }
  if (/%2f/iu.test(url.pathname)) {
    throw Object.assign(new TypeError('File URL path must not include encoded / characters'), {
      code: 'ERR_INVALID_FILE_URL_PATH'
    });
  }
  return decodeURIComponent(url.pathname);
}

/**
 * Node's `pathToFileURL`: a relative path resolves against the working
 * directory, a trailing slash stays (it marks a directory URL, which module
 * resolvers resolve against), and `%`, `#`, `?` and control characters are
 * escaped instead of starting a query or fragment.
 */
function pathToFileURL(path: string, cwd: () => string): URL {
  let resolved = normalizePath(path.startsWith('/') ? path : `${cwd()}/${path}`);
  if (path.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
  const url = new URL('file://');
  url.pathname = resolved
    .replaceAll('%', '%25')
    .replaceAll('\\', '%5C')
    .replaceAll('\n', '%0A')
    .replaceAll('\r', '%0D')
    .replaceAll('\t', '%09')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F');
  return url;
}
