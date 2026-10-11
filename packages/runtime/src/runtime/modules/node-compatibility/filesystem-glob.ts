import type { DirentLike } from '../virtual-file-system';

/**
 * `fs.glob`, `fs.globSync` and `fs.promises.glob` of Node 22: brace
 * expansion, `*`, `?`, `[…]` and `**` segments, names that start with a dot
 * matched only by a pattern segment that starts with one, results relative to
 * `cwd` for a relative pattern and absolute for an absolute one.
 */
export type GlobOptions = {
  readonly cwd?: string | URL;
  readonly exclude?: ((entry: string | DirentLike) => boolean) | readonly string[];
  readonly withFileTypes?: boolean;
};

/** Makes the `Dirent` a `withFileTypes` result carries, given the directory it was listed in. */
export type GlobDirentFactory = (entry: DirentLike, parentPath: string) => DirentLike;

export type GlobDirectoryReader<Result> = (path: string) => Result;

type Segment = { readonly kind: 'globstar' } | { readonly kind: 'literal'; readonly name: string } | {
  readonly kind: 'pattern';
  readonly matches: (name: string) => boolean;
};

type Match = {
  readonly path: string;
  readonly absolute: string;
  readonly entry: DirentLike | undefined;
  readonly parent: string;
};

/**
 * Where `exclude` leaves entries out, as Node 22 applies it. A function is
 * asked about each directory the walk would enter, by its path as results
 * spell it, and about each entry a `**` segment looks at, by its name (a
 * `Dirent` with `withFileTypes`): what it excludes is neither matched nor
 * entered. Patterns are resolved against `cwd` and matched against the
 * absolute path of each directory the walk would enter and of each result.
 */
type Exclusion = {
  directory(path: string, absolute: string, entry: DirentLike, parent: string): boolean;
  entry(entry: DirentLike, parent: string): boolean;
  result(absolute: string): boolean;
};

export function globSync(
  patterns: string | readonly string[],
  cwd: string,
  options: GlobOptions,
  readDirectory: GlobDirectoryReader<readonly DirentLike[]>,
  direntOf: GlobDirentFactory
): Array<string | DirentLike> {
  const generator = globWalk(patterns, cwd, options, direntOf);
  let step = generator.next();
  while (!step.done) {
    let entries: readonly DirentLike[];
    try {
      entries = readDirectory(step.value);
    } catch {
      entries = [];
    }
    step = generator.next(entries);
  }
  return step.value;
}

export async function globAsync(
  patterns: string | readonly string[],
  cwd: string,
  options: GlobOptions,
  readDirectory: GlobDirectoryReader<Promise<readonly DirentLike[]>>,
  direntOf: GlobDirentFactory
): Promise<Array<string | DirentLike>> {
  const generator = globWalk(patterns, cwd, options, direntOf);
  let step = generator.next();
  while (!step.done) {
    let entries: readonly DirentLike[];
    try {
      entries = await readDirectory(step.value);
    } catch {
      entries = [];
    }
    step = generator.next(entries);
  }
  return step.value;
}

/** Yields each directory it needs listed and receives its entries, so one walk serves both forms. */
function* globWalk(
  patterns: string | readonly string[],
  cwd: string,
  options: GlobOptions,
  direntOf: GlobDirentFactory
): Generator<string, Array<string | DirentLike>, readonly DirentLike[]> {
  const listings = new Map<string, readonly DirentLike[]>();
  function* list(directory: string): Generator<string, readonly DirentLike[], readonly DirentLike[]> {
    const cached = listings.get(directory);
    if (cached) return cached;
    const entries = yield directory;
    listings.set(directory, entries);
    return entries;
  }

  const excluded = exclusion(options.exclude, cwd, options.withFileTypes === true, direntOf);
  const found = new Map<string, Match>();
  for (const pattern of (typeof patterns === 'string' ? [patterns] : patterns).flatMap(expandBraces)) {
    const absolute = pattern.startsWith('/');
    // A trailing slash asks for directories only.
    const directoriesOnly = pattern.endsWith('/');
    const names = collapseParentSegments(pattern.split('/').filter((segment) => segment !== '' && segment !== '.'));
    // Leading `..` segments start the walk that many directories up, and stay in the results.
    let up = 0;
    while (!absolute && names[up] === '..') up += 1;
    const segments = names.slice(up).map(compileSegment);
    const root = absolute ? '/' : resolvePath(cwd, '../'.repeat(up));
    const prefix = '../'.repeat(up);
    const display = (relative: string) =>
      absolute ? `/${relative}` : (relative ? `${prefix}${relative}` : prefix.slice(0, -1)) || '.';

    const pending: Array<{ readonly directory: string; readonly relative: string; readonly index: number }> = [
      { directory: root, relative: '', index: 0 }
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const { directory, relative, index } = pending.pop()!;
      const key = `${index}\0${directory}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (index === segments.length) continue;
      const segment = segments[index]!;
      const entries = yield* list(directory);
      const last = index === segments.length - 1;
      // An excluded directory is not entered: nothing below it is listed or matched.
      const enters = (entry: DirentLike, childRelative: string): boolean =>
        !excluded.directory(display(childRelative), joinPath(directory, entry.name), entry, directory);
      if (segment.kind === 'globstar') {
        // `**` matches no directory at all, and then each directory below this one.
        if (last) {
          addMatch(found, display(relative), directory, directory, undefined);
        } else {
          pending.push({ directory, relative, index: index + 1 });
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || excluded.entry(entry, directory)) continue;
          const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
          const child = joinPath(directory, entry.name);
          if (last && (!directoriesOnly || entry.isDirectory())) {
            addMatch(found, display(childRelative), child, directory, entry);
          }
          if (entry.isDirectory() && enters(entry, childRelative)) {
            pending.push({ directory: child, relative: childRelative, index });
          }
        }
        continue;
      }
      for (const entry of entries) {
        if (segment.kind === 'literal' ? entry.name !== segment.name : !segment.matches(entry.name)) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (last) {
          if (!directoriesOnly || entry.isDirectory() || entry.isSymbolicLink()) {
            addMatch(found, display(childRelative), joinPath(directory, entry.name), directory, entry);
          }
        } else if ((entry.isDirectory() || entry.isSymbolicLink()) && enters(entry, childRelative)) {
          pending.push({ directory: joinPath(directory, entry.name), relative: childRelative, index: index + 1 });
        }
      }
    }
  }

  const results: Array<string | DirentLike> = [];
  for (const match of found.values()) {
    if (excluded.result(match.absolute)) continue;
    results.push(options.withFileTypes && match.entry ? direntOf(match.entry, match.parent) : match.path);
  }
  return results;
}

function addMatch(
  found: Map<string, Match>,
  path: string,
  absolute: string,
  parent: string,
  entry: DirentLike | undefined
): void {
  if (!found.has(path)) found.set(path, { path, absolute, entry, parent });
}

function exclusion(
  exclude: GlobOptions['exclude'],
  cwd: string,
  withFileTypes: boolean,
  direntOf: GlobDirentFactory
): Exclusion {
  if (typeof exclude === 'function') {
    return {
      directory: (path, _absolute, entry, parent) => exclude(withFileTypes ? direntOf(entry, parent) : path),
      entry: (entry, parent) => exclude(withFileTypes ? direntOf(entry, parent) : entry.name),
      result: () => false
    };
  }
  if (!exclude || exclude.length === 0) return { directory: () => false, entry: () => false, result: () => false };
  const matchers = exclude.flatMap(expandBraces).map((pattern) => {
    const segments = resolvePath(cwd, pattern).split('/').filter(Boolean).map(compileSegment);
    return (path: string) => matchPath(segments, path.split('/').filter(Boolean));
  });
  const matches = (absolute: string) => matchers.some((match) => match(absolute));
  return { directory: (_path, absolute) => matches(absolute), entry: () => false, result: matches };
}

/** `a/../b` is `b`, as Node's matcher simplifies a pattern; `..` after `..` or `**` stays. */
function collapseParentSegments(names: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const name of names) {
    const previous = collapsed.at(-1);
    if (name === '..' && previous !== undefined && previous !== '..' && previous !== '**') collapsed.pop();
    else collapsed.push(name);
  }
  return collapsed;
}

/** `path` resolved against the absolute directory `base`, without `.` and `..` segments. */
function resolvePath(base: string, path: string): string {
  const names: string[] = [];
  for (const name of `${path.startsWith('/') ? '' : base}/${path}`.split('/')) {
    if (name === '' || name === '.') continue;
    if (name === '..') names.pop();
    else names.push(name);
  }
  return `/${names.join('/')}`;
}

function matchPath(segments: readonly Segment[], names: readonly string[]): boolean {
  if (segments.length === 0) return names.length === 0;
  const [segment, ...rest] = segments;
  if (segment!.kind === 'globstar') {
    for (let skip = 0; skip <= names.length; skip += 1) {
      if (matchPath(rest, names.slice(skip))) return true;
      if (names[skip]?.startsWith('.')) return false;
    }
    return false;
  }
  if (names.length === 0) return false;
  const matched = segment!.kind === 'literal' ? names[0] === segment!.name : segment!.matches(names[0]!);
  return matched && matchPath(rest, names.slice(1));
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

function compileSegment(segment: string): Segment {
  if (segment === '**') return { kind: 'globstar' };
  if (!/[*?[\\]/.test(segment)) return { kind: 'literal', name: segment };
  let source = '';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (character === '\\' && index + 1 < segment.length) {
      source += escapeRegExp(segment[++index]!);
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[') {
      const end = segment.indexOf(']', index + 2);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      let body = segment.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      source += `[${body.replace(/\\/g, '\\\\')}]`;
      index = end;
    } else {
      source += escapeRegExp(character);
    }
  }
  const expression = new RegExp(`^${source}$`);
  const explicitDot = segment.startsWith('.');
  return { kind: 'pattern', matches: (name) => (explicitDot || !name.startsWith('.')) && expression.test(name) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** `a{b,c{d,e}}f` → `abf`, `acdf`, `acef`; a brace without a comma or a range stays literal. */
export function expandBraces(pattern: string): string[] {
  let depth = 0;
  let open = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
    } else if (character === '{') {
      if (depth === 0) open = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth !== 0) continue;
      const body = pattern.slice(open + 1, index);
      const alternatives = splitAlternatives(body);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
      const options = range ? numberRange(Number(range[1]), Number(range[2])) : alternatives;
      if (options.length < 2 && !range) continue;
      const prefix = pattern.slice(0, open);
      const suffix = pattern.slice(index + 1);
      return options.flatMap((option) => expandBraces(`${prefix}${option}${suffix}`));
    }
  }
  return [pattern];
}

function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\') index += 1;
    else if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function numberRange(from: number, to: number): string[] {
  const step = from <= to ? 1 : -1;
  const values: string[] = [];
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) values.push(String(value));
  return values;
}
