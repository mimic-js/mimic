import type { FileSystemTree } from '../../src/runtime';

/** The tree a container mounts for files given by their paths relative to the working directory. */
export function treeOf(files: Readonly<Record<string, string>>): FileSystemTree {
  const root: FileSystemTree = {};
  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split('/');
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      const node = (directory[segment] ??= { directory: {} });
      if (!('directory' in node)) throw new Error(`${path} nests a file under a file`);
      directory = node.directory;
    }
    directory[segments.at(-1)!] = { file: { contents } };
  }
  return root;
}
