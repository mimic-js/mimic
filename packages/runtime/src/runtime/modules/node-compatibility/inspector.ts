/**
 * `node:inspector` for a runtime no debugger can attach to: it reports that
 * nothing is listening, and a session cannot connect. Tools import the module
 * only to ask whether they are being debugged.
 */
export function createInspectorBuiltin(runtimeConsole: object): unknown {
  const unavailable = (): Error =>
    Object.assign(new Error('Inspector is not available'), { code: 'ERR_INSPECTOR_NOT_AVAILABLE' });

  class Session {
    connect(): void {
      throw unavailable();
    }

    connectToMainThread(): void {
      throw unavailable();
    }

    disconnect(): void {}

    post(): never {
      throw Object.assign(new Error('Session is not connected'), { code: 'ERR_INSPECTOR_NOT_CONNECTED' });
    }
  }

  const inspector = {
    Session,
    close: (): void => {},
    console: runtimeConsole,
    open: (): never => {
      throw unavailable();
    },
    url: (): undefined => undefined,
    waitForDebugger: (): never => {
      throw Object.assign(new Error('Inspector is not active'), { code: 'ERR_INSPECTOR_NOT_ACTIVE' });
    }
  };
  return { ...inspector, default: inspector };
}
