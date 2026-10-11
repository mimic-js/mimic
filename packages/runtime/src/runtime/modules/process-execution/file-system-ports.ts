export type ProcessFileSystemTree = {
  [name: string]: ProcessFileSystemTreeNode;
};

export type ProcessFileSystemTreeNode = (
  | { file: { contents: string | Uint8Array | ArrayBuffer } }
  | { symlink: { target: string } }
  | { directory: ProcessFileSystemTree }
) & { readonly mtimeMs?: number };

export interface ProcessFileSystemClient {
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  mount(tree: ProcessFileSystemTree, mountPoint?: string): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string, encoding?: null): Promise<Uint8Array>;
  readdir(path: string): Promise<Array<string | { readonly name: string }>>;
  realpath(path: string): Promise<string>;
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void>;
  stat(path: string): Promise<{
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}
