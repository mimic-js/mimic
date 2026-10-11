export class NodeExit extends Error {
  readonly mimicProcessExit = true;

  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export function createNodeExitSignal(code: number): Error {
  return new NodeExit(code);
}

export function isNodeExitSignal(error: unknown): boolean {
  const seen = new Set<object>();
  let candidate = error;
  while (
    candidate !== null &&
    typeof candidate === 'object' &&
    !seen.has(candidate)
  ) {
    const code = Reflect.get(candidate, 'code');
    if (candidate instanceof NodeExit) return true;
    if (
      Reflect.get(candidate, 'mimicProcessExit') === true &&
      typeof code === 'number'
    ) return true;
    seen.add(candidate);
    candidate = Reflect.get(candidate, 'cause');
  }
  return false;
}
