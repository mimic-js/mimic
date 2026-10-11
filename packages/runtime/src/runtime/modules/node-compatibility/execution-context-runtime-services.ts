import type { HttpListenerClaims } from './http';

export type ExecutionContextRuntimeServices = {
  moduleSourceFooter(filename: string): string;
  httpListenerClaims(protocol: 'http' | 'https'): HttpListenerClaims | undefined;
};

export function createExecutionContextRuntimeServices(options: {
  readonly httpListenerClaims?: (
    protocol: 'http' | 'https'
  ) => HttpListenerClaims | undefined;
} = {}): ExecutionContextRuntimeServices {
  return {
    moduleSourceFooter: () => '',
    httpListenerClaims: (protocol) => options.httpListenerClaims?.(protocol)
  };
}
