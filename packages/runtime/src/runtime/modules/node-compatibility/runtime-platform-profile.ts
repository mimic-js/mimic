export type VirtualPlatform = Readonly<{
  operatingSystem: 'linux';
  architecture: 'wasm32';
  runtime: 'browser';
  nodeVersion: '22.22.3';
  /** The version of the runtime package, reported as `process.versions.webcontainer` (ADR-0045). */
  runtimeVersion: '0.1.0';
}>;

export const VIRTUAL_PLATFORM: VirtualPlatform = {
  operatingSystem: 'linux',
  architecture: 'wasm32',
  runtime: 'browser',
  nodeVersion: '22.22.3',
  runtimeVersion: '0.1.0'
};
