import posixPath from 'path-browserify';

type ParsedPath = { root: string; dir: string; base: string; ext: string; name: string };
type FormatInput = Partial<ParsedPath>;

/**
 * `node:path`. The POSIX half is `path-browserify`, Node's own `lib/path.js`
 * (ADR-0026). It is given the context's working directory, which it would
 * otherwise read from a `process` global, and spells `format` with an `ext`
 * that lacks its dot as Node 19+ does. `path.win32` translates separators over
 * the same functions; no maintained browser port carries Node's win32 half.
 */
export function createPathBuiltin(cwd: () => string): unknown {
  const resolve = (...parts: string[]) => posixPath.resolve(cwd(), ...parts);
  const posix = {
    ...posixPath,
    resolve,
    relative: (from: string, to: string) => posixPath.relative(resolve(from), resolve(to)),
    format: (pathObject: FormatInput) =>
      posixPath.format(
        pathObject?.ext && !pathObject.ext.startsWith('.')
          ? { ...pathObject, ext: `.${pathObject.ext}` }
          : pathObject
      ),
    toNamespacedPath: (path: string) => path,
    posix: undefined as unknown,
    win32: undefined as unknown
  };
  const win32 = createWin32Path(posix);
  posix.posix = posix;
  posix.win32 = win32;
  win32.posix = posix;
  win32.win32 = win32;
  return { ...posix, default: posix };
}

function createWin32Path(posix: typeof posixPath): Record<string, unknown> {
  const toPosix = (value: string) => value.replaceAll('\\', '/');
  const toWin32 = (value: string) => value.replaceAll('/', '\\');
  const rootOf = (value: string): string => {
    const normalized = toPosix(value);
    const unc = normalized.match(/^\/\/[^/]+\/[^/]+\/?/u)?.[0];
    if (unc) return value.slice(0, unc.length);
    const drive = normalized.match(/^[A-Za-z]:\/?/u)?.[0];
    if (drive) return value.slice(0, drive.length);
    return normalized.startsWith('/') ? value.slice(0, 1) : '';
  };
  const parse = (value: string): ParsedPath => {
    const root = rootOf(value);
    const normalizedRoot = toPosix(root);
    const tail = toPosix(value).slice(normalizedRoot.length).replace(/\/+$/u, '');
    const separator = tail.lastIndexOf('/');
    const base = separator < 0 ? tail : tail.slice(separator + 1);
    const directoryTail = separator < 0 ? '' : tail.slice(0, separator);
    const dir = toWin32(`${normalizedRoot}${directoryTail}`) || root;
    const ext = posix.extname(base);
    return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  };
  const normalize = (value: string) => toWin32(posix.normalize(toPosix(value)));
  return {
    join: (...parts: string[]) => normalize(parts.join('\\')),
    resolve: (...parts: string[]) => toWin32(posix.resolve(...parts.map(toPosix))),
    normalize,
    isAbsolute: (value: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|[\\/])/u.test(value),
    relative: (from: string, to: string) => toWin32(posix.relative(toPosix(from), toPosix(to))),
    dirname: (value: string) => parse(value).dir,
    basename: (value: string) => parse(value).base,
    extname: (value: string) => parse(value).ext,
    parse,
    toNamespacedPath: (value: string) => value,
    sep: '\\',
    delimiter: ';',
    posix: undefined,
    win32: undefined
  };
}
