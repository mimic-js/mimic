export type ModuleFormat =
  | 'builtin'
  | 'commonjs'
  | 'commonjs-typescript'
  | 'json'
  | 'module'
  | 'module-typescript'
  | 'wasm';

export type RuntimeArtifactErrorCode =
  | 'ERR_RUNTIME_ARTIFACT_COMPILE'
  | 'ERR_RUNTIME_ARTIFACT_EVALUATION'
  | 'ERR_RUNTIME_ARTIFACT_EVALUATION_DENIED';

export interface RuntimeArtifactLocation {
  readonly source: string;
  readonly line: number;
  readonly column: number;
}

/**
 * A module that could not be compiled or instantiated, as the program that
 * loaded it sees the failure: the code, the module and, when the compiler or
 * the platform reported one, the source location.
 */
export class RuntimeArtifactError extends Error {
  readonly name = 'RuntimeArtifactError';

  constructor(
    message: string,
    readonly code: RuntimeArtifactErrorCode,
    readonly location?: RuntimeArtifactLocation,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class RuntimeAsyncTaskRejection extends Error {
  readonly name = 'RuntimeAsyncTaskRejection';

  constructor(readonly reason: unknown) {
    const cause = reason instanceof Error ? reason : new Error(String(reason));
    super(`Unhandled asynchronous runtime task rejection: ${cause.message}`, { cause });
  }
}

export function runtimeArtifactError(
  code: Exclude<RuntimeArtifactErrorCode, 'ERR_RUNTIME_ARTIFACT_EVALUATION_DENIED'>,
  artifact: Readonly<{ format: string; identity: string }>,
  error: unknown
): RuntimeArtifactError {
  if (error instanceof RuntimeArtifactError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  if (isPlatformEvaluationDenial(cause)) {
    return new RuntimeArtifactError(
      `Runtime evaluation was denied by the embedding Content Security Policy for ${artifact.identity}: ${cause.message}`,
      'ERR_RUNTIME_ARTIFACT_EVALUATION_DENIED',
      undefined,
      { cause }
    );
  }
  const location = sourceLocation(cause, artifact.identity);
  const phase = code === 'ERR_RUNTIME_ARTIFACT_COMPILE' ? 'compile' : 'evaluate';
  const suffix = location ? ` at ${location.source}:${location.line}:${location.column}` : '';
  const subject =
    code === 'ERR_RUNTIME_ARTIFACT_COMPILE' && artifact.format === 'commonjs'
      ? `Cannot compile CommonJS module ${artifact.identity}`
      : `Cannot ${phase} ${artifact.format} artifact ${artifact.identity}`;
  return new RuntimeArtifactError(`${subject}${suffix}: ${cause.message}`, code, location, { cause });
}

function isPlatformEvaluationDenial(error: Error): boolean {
  return error.name === 'EvalError' ||
    /(?:content security policy|unsafe-eval|wasm-unsafe-eval|refused to (?:evaluate|compile))/i.test(error.message);
}

function sourceLocation(error: Error, identity: string): RuntimeArtifactLocation | undefined {
  const located = error as Error & { readonly loc?: { readonly line?: unknown; readonly column?: unknown } };
  if (typeof located.loc?.line === 'number' && typeof located.loc.column === 'number') {
    return { source: identity, line: located.loc.line, column: located.loc.column + 1 };
  }
  const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = error.stack?.match(new RegExp(`${escapedIdentity}:(\\d+):(\\d+)`));
  return match ? { source: identity, line: Number(match[1]), column: Number(match[2]) } : undefined;
}
