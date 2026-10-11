import { portDependencies } from './registry';

/** `buffer` as the adopted ports import it: the runtime's `node:buffer`. */
export const { Buffer, Blob, File, SlowBuffer, atob, btoa, constants, INSPECT_MAX_BYTES, isAscii, isUtf8, kMaxLength, kStringMaxLength } =
  portDependencies().buffer;
