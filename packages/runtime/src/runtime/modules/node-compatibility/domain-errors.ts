export type NodeCompatibilityDomainOwner =
  | 'virtual-file-system'
  | 'process-execution'
  | 'virtual-network'
  | 'http-1-wire-codec';

const DOMAIN_TO_NODE_ERROR = new Map<string, string>([
  ['virtual-file-system:NOT_FOUND', 'ENOENT'],
  ['virtual-file-system:ALREADY_EXISTS', 'EEXIST'],
  ['virtual-file-system:NOT_DIRECTORY', 'ENOTDIR'],
  ['virtual-file-system:IS_DIRECTORY', 'EISDIR'],
  ['virtual-file-system:INVALID_ARGUMENT', 'EINVAL'],
  ['virtual-file-system:ARCHIVE_TOO_LARGE', 'EFBIG'],
  ['virtual-file-system:SYMBOLIC_LINK_LOOP', 'ELOOP'],
  ['virtual-file-system:DIRECTORY_NOT_EMPTY', 'ENOTEMPTY'],
  ['virtual-file-system:OPERATION_NOT_PERMITTED', 'EPERM'],
  ['virtual-file-system:BAD_FILE_DESCRIPTOR', 'EBADF'],
  ['virtual-file-system:ALREADY_INITIALIZED', 'EALREADY'],
  ['virtual-file-system:IO_FAILURE', 'EIO'],
  ['process-execution:CAPACITY_EXHAUSTED', 'EAGAIN'],
  ['process-execution:PARK_LIMIT_EXHAUSTED', 'EAGAIN'],
  ['process-execution:PARENT_TERMINATED', 'ECANCELED'],
  ['process-execution:OUTPUT_LIMIT_EXCEEDED', 'ENOBUFS'],
  ['process-execution:TIMEOUT', 'ETIMEDOUT'],
  ['process-execution:EXECUTION_FAILED', 'EIO'],
  ['process-execution:INPUT_FAILED', 'EIO'],
  ['process-execution:EXECUTABLE_NOT_FOUND', 'ENOENT'],
  ['process-execution:UNSUPPORTED_INTERPRETER', 'ENOEXEC'],
  ['process-execution:RESOLUTION_CYCLE', 'ELOOP'],
  ['process-execution:INVALID_INLINE_ENTRY', 'EINVAL'],
  ['process-execution:INVALID_CONTEXT', 'ESRCH'],
  ['process-execution:INVALID_PARENT', 'ESRCH'],
  ['process-execution:UNKNOWN_PROCESS', 'ESRCH'],
  ['virtual-network:ADDRESS_IN_USE', 'EADDRINUSE'],
  ['virtual-network:CONNECTION_REFUSED', 'ECONNREFUSED'],
  ['virtual-network:CANCELED', 'ECANCELED'],
  ['virtual-network:EXTERNAL_TRANSPORT_UNSUPPORTED', 'ENOTSUP'],
  ['virtual-network:UNSUPPORTED', 'ENOTSUP']
]);

export function nodeErrorCodeFromDomain(owner: NodeCompatibilityDomainOwner, code: string): string | undefined {
  return DOMAIN_TO_NODE_ERROR.get(`${owner}:${code}`);
}
