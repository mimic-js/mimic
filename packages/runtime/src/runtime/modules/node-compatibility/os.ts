import { NODE_ERRNO_CONSTANTS, NODE_SIGNAL_CONSTANTS } from './constants';
import { VIRTUAL_PLATFORM } from './runtime-platform-profile';

/** `node:os`, reporting the runtime's one platform identity (ADR-0016). */
export function createOsBuiltin(): unknown {
  const os = {
    EOL: '\n',
    constants: { errno: { ...NODE_ERRNO_CONSTANTS }, signals: { ...NODE_SIGNAL_CONSTANTS } },
    arch: () => VIRTUAL_PLATFORM.architecture,
    availableParallelism: () => globalThis.navigator?.hardwareConcurrency ?? 1,
    cpus: () =>
      Array.from({ length: globalThis.navigator?.hardwareConcurrency ?? 1 }, () => ({
        model: 'mimic',
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
      })),
    endianness: () => 'LE',
    freemem: () => 0,
    homedir: () => '/home/project',
    hostname: () => 'mimic',
    networkInterfaces: () => ({
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8'
        }
      ]
    }),
    platform: () => VIRTUAL_PLATFORM.operatingSystem,
    release: () => '0.0.0',
    tmpdir: () => '/tmp',
    totalmem: () => 0,
    // What uname -s reports, as Node on Linux returns it (ADR-0039).
    type: () => 'Linux',
    userInfo: () => ({
      uid: 1000,
      gid: 1000,
      username: 'browser',
      homedir: '/home/project',
      shell: null
    })
  };

  return {
    ...os,
    default: os
  };
}
