import type { ProcessExecutionSignal } from './process-execution';
import type { ThreadIdentity } from './child-requests';

export type RuntimeExecutionWorker = Pick<
  Worker,
  'addEventListener' | 'postMessage' | 'removeEventListener' | 'terminate'
>;

export interface RuntimeExecutionContext {
  readonly id: number;
  /** Admits a worker thread of one of this context's processes under its parent thread. */
  admitThread(identity: ThreadIdentity, parentThreadId: number): Promise<void>;
  completeThread(identity: ThreadIdentity): Promise<void>;
  readonly forcedTermination: Promise<ProcessExecutionSignal>;
  openWorker(createWorker: () => Worker): RuntimeExecutionWorker;
}

export interface RuntimeProgram<Context = unknown> {
  readonly id: string;
  readonly commands: readonly string[];
  readonly classificationOnly?: true;
  readonly handlesSignals?: boolean;
  run(
    args: readonly string[],
    context: Context
  ): Promise<number | void> | number | void;
}

/**
 * The one table of Runtime Programs: every command Process Execution can
 * resolve without searching the filesystem, and the program that runs it.
 */
export interface RuntimeProgramRegistry<
  Program extends RuntimeProgramIdentity = RuntimeProgramIdentity
> {
  /** In registration order, which is the order executable inspection tries them. */
  readonly programs: readonly Program[];
  /** Finds a program by its id or by one of its commands. */
  resolve(command: string): Program | undefined;
}

export type RuntimeProgramIdentity = Pick<
  RuntimeProgram,
  'id' | 'commands' | 'classificationOnly'
>;

export function createRuntimeProgramRegistry<
  Program extends RuntimeProgramIdentity
>(programs: readonly Program[]): RuntimeProgramRegistry<Program> {
  const programsByCommand = new Map<string, Program>();
  const programsById = new Map<string, Program>();
  for (const program of programs) {
    if (program.commands.length === 0 && program.classificationOnly !== true) {
      throw new Error(`Runtime Program "${program.id}" must own at least one command.`);
    }
    const existingId = programsById.get(program.id);
    if (existingId) {
      throw new Error(`Runtime Program id "${program.id}" is already registered.`);
    }
    const commandOwner = programsByCommand.get(program.id);
    if (commandOwner) {
      throw new Error(
        `Runtime Program id "${program.id}" conflicts with a command owned by "${commandOwner.id}".`
      );
    }
    programsById.set(program.id, program);
    for (const command of program.commands) {
      const existing = programsByCommand.get(command);
      if (existing) {
        throw new Error(
          `Runtime Program command "${command}" is already owned by "${existing.id}".`
        );
      }
      const idOwner = programsById.get(command);
      if (idOwner && idOwner !== program) {
        throw new Error(
          `Runtime Program command "${command}" conflicts with Runtime Program id "${idOwner.id}".`
        );
      }
      programsByCommand.set(command, program);
    }
  }

  return {
    programs: Object.freeze([...programs]),
    resolve: (command) => programsById.get(command) ?? programsByCommand.get(command)
  };
}
