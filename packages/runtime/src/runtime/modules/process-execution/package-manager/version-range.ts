/** The candidates that share `version`'s major number; prereleases are not candidates. */
export function sameMajorLine(version: string, candidates: readonly string[]): readonly string[] {
  const wanted = parseVersion(version);
  if (!wanted) return [];
  return candidates.filter((candidate) => {
    const parsed = parseVersion(candidate);
    return parsed !== undefined && parsed.prerelease.length === 0 && parsed.core[0] === wanted.core[0];
  });
}

/**
 * The candidate nearest to `version`: the newest one below it or the oldest
 * one above it, whichever differs from it in the less significant part, and
 * the one above when they differ alike. Prereleases are not candidates.
 */
export function nearestVersion(version: string, candidates: readonly string[]): string | undefined {
  const wanted = parseVersion(version);
  if (!wanted) return undefined;
  let below: { readonly text: string; readonly parsed: Version } | undefined;
  let above: { readonly text: string; readonly parsed: Version } | undefined;
  for (const text of candidates) {
    const parsed = parseVersion(text);
    if (!parsed || parsed.prerelease.length > 0) continue;
    const order = compareVersion(parsed, wanted);
    if (order === 0) return text;
    if (order < 0 && (!below || compareVersion(parsed, below.parsed) > 0)) below = { text, parsed };
    if (order > 0 && (!above || compareVersion(parsed, above.parsed) < 0)) above = { text, parsed };
  }
  if (!below || !above) return (above ?? below)?.text;
  for (let index = 0; index < 3; index += 1) {
    const down = wanted.core[index]! - below.parsed.core[index]!;
    const up = above.parsed.core[index]! - wanted.core[index]!;
    if (down !== up) return down < up ? below.text : above.text;
  }
  return above.text;
}

type Version = Readonly<{
  core: readonly [major: number, minor: number, patch: number];
  prerelease: readonly (number | string)[];
}>;

function parseVersion(version: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.').map((identifier) =>
      /^\d+$/u.test(identifier) ? Number(identifier) : identifier
    ) ?? []
  };
}

function compareVersion(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return (left.core[index] ?? 0) > (right.core[index] ?? 0) ? 1 : -1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (typeof leftIdentifier === 'number' && typeof rightIdentifier === 'number') {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (typeof leftIdentifier === 'number' || typeof rightIdentifier === 'number') {
      return typeof leftIdentifier === 'number' ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}
