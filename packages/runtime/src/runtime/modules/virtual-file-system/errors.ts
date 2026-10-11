import type { VfsCommitOperation, VfsDomainError } from './types';

export class VirtualFileSystemError extends Error {
  readonly code: string;
  readonly operationIndex: number | undefined;
  readonly operationType: VfsCommitOperation['type'] | undefined;

  constructor(error: VfsDomainError) {
    super(error.message);
    this.name = 'VirtualFileSystemError';
    this.code = error.code;
    this.operationIndex = error.operationIndex;
    this.operationType = error.operationType;
  }
}
