export type ShellParameterOperator =
  | ':-'
  | '-'
  | ':='
  | '='
  | ':+'
  | '+'
  | ':?'
  | '?'
  | '%'
  | '%%'
  | '#'
  | '##';

export type ShellWordPart =
  | Readonly<{ readonly kind: 'literal'; readonly value: string; readonly quoted: boolean }>
  | Readonly<{ readonly kind: 'tilde' }>
  | Readonly<{
      readonly kind: 'parameter';
      readonly name: string;
      readonly quoted: boolean;
      readonly length?: true;
      readonly operator?: ShellParameterOperator;
      readonly argument?: ShellWord;
    }>
  | Readonly<{ readonly kind: 'command'; readonly body: ShellList; readonly quoted: boolean }>
  | Readonly<{ readonly kind: 'arithmetic'; readonly expression: string; readonly quoted: boolean }>;

export type ShellWord = Readonly<{
  readonly parts: readonly ShellWordPart[];
}>;

export type ShellRedirection = Readonly<{
  readonly fd: number;
  readonly kind: 'input' | 'output' | 'append' | 'duplicate-input' | 'duplicate-output';
  readonly target: ShellWord;
}>;

export type ShellAssignment = Readonly<{
  readonly name: string;
  readonly value: ShellWord;
}>;

export type ShellSimpleCommand = Readonly<{
  readonly kind: 'simple';
  readonly assignments: readonly ShellAssignment[];
  readonly words: readonly ShellWord[];
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellSubshellCommand = Readonly<{
  readonly kind: 'subshell';
  readonly body: ShellList;
  /** The script text between the parentheses, run by the subshell's own Runtime Process. */
  readonly source: string;
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellGroupCommand = Readonly<{
  readonly kind: 'group';
  readonly body: ShellList;
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellIfCommand = Readonly<{
  readonly kind: 'if';
  readonly clauses: readonly Readonly<{ readonly condition: ShellList; readonly body: ShellList }>[];
  readonly otherwise?: ShellList;
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellForCommand = Readonly<{
  readonly kind: 'for';
  readonly variable: string;
  /** Absent for `for name do`, which iterates the positional parameters. */
  readonly items?: readonly ShellWord[];
  readonly body: ShellList;
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellWhileCommand = Readonly<{
  readonly kind: 'while';
  readonly until: boolean;
  readonly condition: ShellList;
  readonly body: ShellList;
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellCaseCommand = Readonly<{
  readonly kind: 'case';
  readonly subject: ShellWord;
  readonly clauses: readonly Readonly<{ readonly patterns: readonly ShellWord[]; readonly body: ShellList }>[];
  readonly redirections: readonly ShellRedirection[];
}>;

export type ShellCommand =
  | ShellSimpleCommand
  | ShellSubshellCommand
  | ShellGroupCommand
  | ShellIfCommand
  | ShellForCommand
  | ShellWhileCommand
  | ShellCaseCommand;

export type ShellPipeline = Readonly<{
  readonly negated: boolean;
  readonly commands: readonly ShellCommand[];
}>;

export type ShellAndOr = Readonly<{
  readonly pipelines: readonly ShellPipeline[];
  readonly operators: readonly ('&&' | '||')[];
}>;

export type ShellListItem = Readonly<{
  readonly andOr: ShellAndOr;
  readonly background: boolean;
}>;

export type ShellList = Readonly<{
  readonly items: readonly ShellListItem[];
}>;
