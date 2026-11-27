// The agent's three Set up this computer tools (docs/designs/onboarding.md, 18.12 and 18.14), for one
// session. `setup_list` reads the checklist (any session). `setup_run_step` and `setup_run_command` run
// something on this computer, and only for a session started by Ask the agent (`purpose: 'setup'`), never
// in Bypass, and each only after the person's yes on a card that shows the exact command and has no
// "always" choice. A step runs through SetupSteps.runLine, the page's own Run. No tool dismisses or
// restores a line, and none is reached from a phone (CONNECT_OPS has none; the card refuses a phone).
import { randomUUID } from 'node:crypto';
import type { InputRequest, KestrelToolHost, ToolResult } from '../agents/types.ts';
import type { Session } from '../model.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import type { Platform } from '../shared/platform.ts';
import { cardCommandText, setupListText, SETUP_BYPASS_REFUSAL, SETUP_ONLY_REFUSAL, SETUP_PURPOSE } from '../shared/setup-agent.ts';
import { agentCommandPlan, runAgentCommand } from './agent-run.ts';
import type { CommandRunner } from './io.ts';
import { agentStepRefusal, type SetupSteps } from './steps.ts';

export interface SetupToolDeps {
  /** This computer's checklist, once Kestrel Connect has made it; null before. */
  steps(): SetupSteps | null;
  session(id: string): Promise<Session | null>;
  /** The session's permission mode now: it can change mid-session. */
  mode(id: string): PermissionLevel | undefined;
  /** The runtime's Kestrel card; resolves to the person's yes or no. */
  approve(id: string, request: InputRequest): Promise<boolean>;
  platform: Platform;
  home: string;
  run: CommandRunner;
}

export const NOT_READY = 'Set up this computer needs Kestrel Connect on, signed in, connected, and this computer let into your account.';

const refused = (text: string): ToolResult => ({ isError: true, text });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const OPTIONS: InputRequest['options'] = [
  { id: 'allow', label: 'Run', role: 'allow' },
  { id: 'deny', label: 'Deny', role: 'deny' },
];

export function setupToolsFor(sessionId: string, deps: SetupToolDeps): Pick<KestrelToolHost, 'setupList' | 'setupRunStep' | 'setupRunCommand'> {
  /** Why this session may not run anything, or null. */
  const mayRun = async (): Promise<string | null> => {
    const session = await deps.session(sessionId);
    if (session?.purpose !== SETUP_PURPOSE) return SETUP_ONLY_REFUSAL;
    if (deps.mode(sessionId) === 'bypass') return SETUP_BYPASS_REFUSAL;
    return null;
  };
  return {
    setupList: async () => {
      const steps = deps.steps();
      if (!steps) return refused(NOT_READY);
      try {
        return { text: setupListText(await steps.list(), steps.runs()) };
      } catch (error) {
        return refused(message(error));
      }
    },

    setupRunStep: async ({ line: id }) => {
      const steps = deps.steps();
      if (!steps) return refused(NOT_READY);
      const no = await mayRun();
      if (no) return refused(no);
      try {
        const list = await steps.list();
        const line = list.lines.find((l) => l.id === id);
        const why = agentStepRefusal(line, list);
        if (why) return refused(why);
        const detail = line!.command ? `${line!.command.text}\n\n${line!.title}` : `${line!.does}\n\n${line!.title}`;
        const yes = await deps.approve(sessionId, { id: `setup_run_step-${randomUUID()}`, kind: 'approval', tool: 'setup_run_step', title: 'Run a set-up step', detail, options: OPTIONS });
        if (!yes) return { text: 'The person chose not to run it. Nothing ran.' };
        const report = await steps.runLine(line!.id);
        const state = steps.runs()[line!.id];
        const outcome = state?.state === 'failed' ? `It failed: ${state.reason}${state.output ? `\nLast output:\n${state.output}` : ''}` : state?.state === 'waiting' ? `It waits on ${state.on}.` : state?.state === 'done' ? `Done: ${state.said}` : 'It ran.';
        const also = report.also.length > 0 ? ` First it ran ${report.also.join(', ')}.` : '';
        return { text: `${outcome}${also} The checklist was read again; call setup_list to see it.` };
      } catch (error) {
        return refused(message(error));
      }
    },

    setupRunCommand: async ({ command, cwd, why }) => {
      const no = await mayRun();
      if (no) return refused(no);
      let plan: { cwd: string };
      try {
        plan = agentCommandPlan(command, cwd, deps.home);
      } catch (error) {
        return refused(message(error));
      }
      const shown = cardCommandText(command, deps.platform);
      const yes = await deps.approve(sessionId, { id: `setup_run_command-${randomUUID()}`, kind: 'approval', tool: 'setup_run_command', title: 'Run a command for Set up this computer', detail: `${shown}\n\nIn ${plan.cwd}\n${why}`, options: OPTIONS });
      if (!yes) return { text: 'The person chose not to run it. Nothing ran.' };
      const text = await runAgentCommand({ home: deps.home, run: deps.run }, command, plan.cwd);
      return { text: `${text}\nThe checklist is read again when it is next asked for; call setup_list to see it.` };
    },
  };
}
