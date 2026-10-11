import { useEffect, useState } from 'react';
import type { Mimic } from '@mimic-js/mimic';

type Entry = {
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
};

type Listings = ReadonlyMap<string, readonly Entry[]>;

type FileTreeProps = {
  readonly container: Mimic;
  /** Changes whenever the container's files may have changed. */
  readonly filesVersion: number;
  readonly activePath: string | undefined;
  readonly onOpen: (path: string) => void;
};

/** The container's working directory, read one expanded directory at a time. */
export function FileTree({ container, filesVersion, activePath, onOpen }: FileTreeProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [listings, setListings] = useState<Listings>(new Map());

  useEffect(() => {
    let cancelled = false;
    const directories = [container.workdir, ...expanded];
    void Promise.all(
      directories.map(async (directory) => [directory, await listDirectory(container, directory)] as const)
    ).then((loaded) => {
      if (!cancelled) setListings(new Map(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [container, expanded, filesVersion]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const renderDirectory = (path: string, depth: number) =>
    listings.get(path)?.map((entry) => (
      <li key={entry.path}>
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 10 + depth * 14 }}
          aria-expanded={entry.directory ? expanded.has(entry.path) : undefined}
          aria-current={entry.path === activePath ? 'true' : undefined}
          onClick={() => (entry.directory ? toggle(entry.path) : onOpen(entry.path))}
        >
          <span className="tree-chevron">{entry.directory ? '›' : ''}</span>
          <span className="tree-name">{entry.name}</span>
        </button>
        {entry.directory && expanded.has(entry.path) && <ul>{renderDirectory(entry.path, depth + 1)}</ul>}
      </li>
    ));

  return <ul className="tree">{renderDirectory(container.workdir, 0)}</ul>;
}

async function listDirectory(container: Mimic, directory: string): Promise<readonly Entry[]> {
  try {
    const entries = await Promise.all(
      (await container.fs.readdir(directory, { withFileTypes: true })).map(async (dirent) => {
        if (typeof dirent === 'string') throw new Error('Expected directory entries with file types.');
        const path = `${directory}/${dirent.name}`;
        const isDirectory = dirent.isSymbolicLink()
          ? await container.fs.stat(path).then((stat) => stat.isDirectory(), () => false)
          : dirent.isDirectory();
        return { name: dirent.name, path, directory: isDirectory };
      })
    );
    return entries.sort(
      (left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name)
    );
  } catch {
    // The directory was removed since it was expanded.
    return [];
  }
}
