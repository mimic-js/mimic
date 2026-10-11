/**
 * Internals of one Runtime Deep Module that another module's tests use as
 * test doubles. A module's own tests import its files by path; a test of
 * another module reaches them through here, not by a deep import.
 */
export { createVirtualProcess } from '../../src/runtime/modules/process-execution/virtual-process';
export { VirtualFileSystem } from '../../src/runtime/modules/virtual-file-system/virtual-file-system';
//# sourceMappingURL=module-internals.d.ts.map