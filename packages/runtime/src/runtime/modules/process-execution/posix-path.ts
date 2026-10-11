/** Resolves a POSIX path against a working directory without consulting the filesystem. */
export function resolvePosixPath(path: string, cwd: string): string {
  const parts: string[] = [];
  for (const part of `${path.startsWith('/') ? '' : `${cwd}/`}${path}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
