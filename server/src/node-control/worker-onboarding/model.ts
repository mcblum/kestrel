export type WorkerStepState = 'pending' | 'active' | 'ready' | 'left';

export interface WorkerStep {
  label: string;
  state: WorkerStepState;
}

export interface WorkerChoice {
  value: string;
  label: string;
  note?: string;
  /** An optional shortcut such as y or n for a confirmation. */
  shortcut?: string;
}

interface WorkerPromptBase {
  /** Unique per question, including retries, so input starts fresh. */
  id: string;
  label: string;
  cancelable?: boolean;
}

export type WorkerPrompt =
  | (WorkerPromptBase & { kind: 'select'; choices: readonly WorkerChoice[]; initial?: string })
  | (WorkerPromptBase & { kind: 'multi'; choices: readonly WorkerChoice[]; initial?: readonly string[] })
  | (WorkerPromptBase & { kind: 'input'; placeholder?: string; initial?: string; maxLength?: number });

export type WorkerAnswer = string | string[] | null;

export type WorkerDetail =
  | { kind: 'text' | 'problem'; text: string }
  | { kind: 'literal'; value: string }
  | { kind: 'field'; label: string; value: string; note?: string }
  | { kind: 'trust'; label: string; action: string; destination: string; reason: string; commands?: readonly string[] }
  | { kind: 'handoff'; program: string; detail: string }
  | { kind: 'outcome'; label: string; state: 'ready' | 'left'; detail?: string; command?: string };

export interface WorkerFrame {
  /** The name used to identify this computer on other devices. */
  node: string;
  /** Worker setup, Pair this worker, Set up agents, or Set up Git. */
  name: string;
  steps?: readonly WorkerStep[];
  title: string;
  description?: string;
  details?: readonly WorkerDetail[];
  status?: string;
}
