const slash = /\/+/g;

export function normalizePath(input: string | URL, cwd = '/'): string {
  const path = input instanceof URL && input.protocol === 'file:' ? decodeURIComponent(input.pathname) : String(input);
  const raw = path.startsWith('/') ? path : `${cwd}/${path}`;
  const parts: string[] = [];

  for (const part of raw.replace(slash, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return `/${parts.join('/')}`;
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index);
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

export function stripLeadingSlash(path: string): string {
  return normalizePath(path).replace(/^\//, '');
}
