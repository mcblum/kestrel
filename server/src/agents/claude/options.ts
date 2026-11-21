// The SDK options Kestrel runs Claude with, from the spike (docs/spike-results.md, "Claude").
// Kept apart from the adapter so the safety-relevant choices can be read and tested alone.
import type { EffortLevel, Options } from '@anthropic-ai/claude-agent-sdk';
import { claudePermission } from '../../shared/permissions.ts';
import type { StartOptions } from '../types.ts';
import { claudeEnv } from './env.ts';
import { claudeExecutable } from './executable.ts';
import { ALL_KESTREL_TOOLS, kestrelToolName } from './map.ts';

/** The account's claude.ai connectors write to outside services; a session carries none.
 *  The only thing relied on is the PreToolUse hook refusing them (see index.ts): neither the
 *  ENABLE_CLAUDEAI_MCP_SERVERS variable nor a wildcard in disallowedTools could be shown to do
 *  anything, so neither is used. */
const CONNECTOR_PREFIX = 'mcp__claude_ai_';
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
/** Without this the SDK's Claude Code offers no task-list tools at all (checked on SDK 0.3.322:
 *  TaskCreate/TaskUpdate/TaskList/TaskGet appear only with it; TodoWrite never does). Kestrel shows
 *  the list as a card, so it is switched on. `claudeEnv` drops the user's CLAUDE* variables, so it
 *  is set here, after that. `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` makes the CLI send
 *  `session_state_changed`, whose 'idle' the SDK calls the authoritative turn-over signal: it is how
 *  a run that waited on background work is known to be over (run-phase.ts). */
const KESTREL_ENV = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
/** Keeping the task list changes nothing on disk, so a read-only session may do it too. */
const TASK_LIST_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];
/** Browser tools that act on a web page (open an address, click, type) rather than look at it.
 *  They are left out of `allowedTools`, so they go through the session's own permission mode:
 *  in Manual each one is an approval card; Auto's classifier decides; Bypass runs them. */
export const BROWSER_ACTIONS = ['browser_navigate', 'browser_click', 'browser_type'].map(kestrelToolName);
/** Of those, the ones that change something on a page. A read-only session never runs them. */
export const BROWSER_WRITES = ['browser_click', 'browser_type'].map(kestrelToolName);
/** Simulator tools that change something (boot, install, tap, type…): they follow the mode like the
 *  browser actions. Listing devices, screenshots and the appearance switch need no approval. */
export const SIM_ACTIONS = ['sim_boot', 'sim_launch', 'sim_tap', 'sim_swipe', 'sim_pinch', 'sim_type', 'sim_key', 'sim_button', 'sim_open_url'].map(kestrelToolName);
/** A read-only session may only look: list the devices and take screenshots. */
export const SIM_WRITES = [...SIM_ACTIONS, kestrelToolName('sim_appearance')];
const READ_ONLY_REFUSED = [...BROWSER_WRITES, ...SIM_WRITES];
const ASKS = [...BROWSER_ACTIONS, ...SIM_ACTIONS];

export function isConnectorTool(name: string): boolean {
  return name.startsWith(CONNECTOR_PREFIX);
}

/** Which settings files Claude Code reads for this session. */
export function settingSourcesFor(setup: StartOptions['setup']): NonNullable<Options['settingSources']> {
  if (!setup?.loadSettings) return [];
  return setup.inProject ? ['user', 'project', 'local'] : ['user'];
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'] satisfies EffortLevel[];

/**
 * Effort and fast mode as the SDK takes them: `effort` is a query option; fast mode is the
 * `fastMode` setting in the flag-settings overlay (`settings`). Without that key the SDK reports
 * fast mode off with `sdk_opt_in_required` (checked on SDK 0.3.322), so it is sent as chosen,
 * on or off, whenever the session has a choice. An effort the SDK does not know is left out.
 */
export function speedOptions(opts: Pick<StartOptions, 'effort' | 'fast'>): Pick<Options, 'effort' | 'settings'> {
  return {
    ...(opts.effort && EFFORTS.includes(opts.effort) ? { effort: opts.effort as EffortLevel } : {}),
    ...(opts.fast !== undefined ? { settings: { fastMode: opts.fast } } : {}),
  };
}

/** Everything except the per-run parts (prompt, hooks, callbacks, resume). */
export function baseOptions(opts: StartOptions, env: Record<string, string | undefined> = process.env): Options {
  const common: Options = {
    cwd: opts.directory,
    model: opts.model,
    ...speedOptions(opts),
    env: { ...claudeEnv({ ...env, ...opts.env }), ...KESTREL_ENV },
    ...claudeExecutable(env),
    // The user's own Claude Code setup (CLAUDE.md, skills, commands, hooks), when the project
    // has it switched on; the project's own settings only when the session works in a project.
    // With no setup at all the session is isolated, as it was before this existed.
    settingSources: settingSourcesFor(opts.setup),
    // MCP servers are never taken from those settings. A session gets Kestrel's own server and
    // the ones the user switched on for this project (see index.ts), and nothing else.
    strictMcpConfig: true,
    includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.instruction },
  };
  const { permissionMode, readOnly } = claudePermission(opts.permission);
  if (readOnly) {
    return {
      ...common,
      permissionMode,
      // Kestrel's own tools are how a read-only session changes anything: it hands off or delegates.
      // It may open and look at pages, but not click or type on them; it may list simulators and
      // take their pictures, nothing more.
      allowedTools: ['Read', 'Grep', 'Glob', ...TASK_LIST_TOOLS, ...ALL_KESTREL_TOOLS.filter((t) => !READ_ONLY_REFUSED.includes(t))],
      disallowedTools: [...WRITE_TOOLS, ...READ_ONLY_REFUSED],
      additionalDirectories: opts.readableDirectories ?? [],
    };
  }
  return {
    ...common,
    // `default` asks (canUseTool) for anything not considered safe; `acceptEdits` lets file edits
    // through and still asks for commands; `plan` runs nothing until the plan is approved.
    // `bypassPermissions` skips every prompt and is produced only by the level the user confirmed.
    // The PreToolUse hook (connector refusal, rules, and an approval for an edit outside the
    // session's folder in Manual and Accept edits) runs in every mode.
    permissionMode,
    ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    // Our own tools need no approval (allowedTools entries skip canUseTool), except the browser
    // and simulator tools that act on something: those follow the mode like any other action.
    allowedTools: ALL_KESTREL_TOOLS.filter((t) => !ASKS.includes(t)),
    // Set for a session with no project (the registered projects) or with sibling directories,
    // and for its attachments. The SDK treats them as working directories, so Accept edits would
    // pass edits there by itself; the hook makes those ask, as anywhere outside the session's folder.
    ...(opts.readableDirectories?.length ? { additionalDirectories: opts.readableDirectories } : {}),
  };
}
