import { nodeStream as stream } from './streams';

/** `node:tty`: no stream of a runtime process is a terminal. */
export function createTtyBuiltin(): unknown {
  const tty = {
    isatty: () => false,
    ReadStream: class ReadStream extends stream.Readable {},
    WriteStream: class WriteStream extends stream.Writable {
      getColorDepth(): number {
        return 1;
      }

      hasColors(): boolean {
        return false;
      }
    }
  };
  return {
    ...tty,
    default: tty
  };
}
