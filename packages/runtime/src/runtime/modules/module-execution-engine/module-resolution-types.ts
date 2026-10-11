export interface ModuleResolutionFileSystem {
  readText(path: string): string;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  realpathSync(path: string): string;
}

export type ModuleResolutionFailureKind =
  | 'invalid-package-target'
  | 'module-not-found'
  | 'package-import-not-defined'
  | 'package-path-not-exported';

export class ModuleResolutionError extends Error {
  readonly name = 'ModuleResolutionError';

  constructor(
    readonly kind: ModuleResolutionFailureKind,
    message: string
  ) {
    super(message);
  }
}
