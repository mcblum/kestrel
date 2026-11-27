// Ask the agent, and what an agent may run for Set up this computer (docs/designs/onboarding.md, 18.12
// and 18.14). Pure: which lines offer Ask the agent, the message it fills in (never sent by itself), the
// checklist as the `setup_list` tool answers it, and the one rule that refuses a command needing an
// administrator. A session started by Ask the agent is marked `purpose: 'setup'`; only such a session may
// run a step or a command, each on the person's yes on a card, never in Bypass, never from a phone.
import { PLATFORM_NAME, type Platform } from './platform.ts';
import { quoteArg, shellOf } from './setup-install.ts';
import { SETUP_GROUPS, type SetupLine, type SetupList } from './setup-list.ts';
import type { SetupRunState, SetupRuns } from './setup-sections.ts';

/** What a session started by Ask the agent is marked with; set only by the tab Ask the agent opened. */
export const SETUP_PURPOSE = 'setup';

export const SETUP_ONLY_REFUSAL = "Only a session started from Set up this computer's Ask the agent can run set-up commands.";
/** The tools that run something on this computer for Set up this computer, each behind a card. */
export const SETUP_RUN_TOOLS = ['setup_run_step', 'setup_run_command'] as const;
export const isSetupRunTool = (tool: string): boolean => (SETUP_RUN_TOOLS as readonly string[]).includes(tool);
export const SETUP_AT_DESK = 'Answer at the desk: a set-up command runs on that computer only on the word of the person at it.';
export const SETUP_BYPASS_REFUSAL = 'Set-up commands always ask; this session is in Bypass. Switch it to Manual or Auto first.';

/** Whether a line offers Ask the agent: one that needs judgment, or one that failed or waits. Pure. */
export function askAgentOf(line: SetupLine, run: SetupRunState | undefined): boolean {
  if (line.done || line.dismissed) return false;
  return line.askAgent || run?.state === 'failed' || run?.state === 'waiting';
}

const groupTitle = (line: SetupLine) => SETUP_GROUPS.find((g) => g.id === line.group)?.title ?? line.group;
const titlesOf = (ids: readonly string[], list: SetupList) => ids.map((id) => list.lines.find((l) => l.id === id)?.title ?? id);

/** A line's state in words, as the agent and the message read it. Pure. */
export function lineStateText(line: SetupLine, list: SetupList, run: SetupRunState | undefined): string {
  if (line.done) return 'done';
  if (line.dismissed) return 'dismissed';
  if (run?.state === 'running') return 'running';
  if (run?.state === 'failed') return `failed: ${run.reason}`;
  if (run?.state === 'waiting') return `waiting on ${run.on}`;
  const unmet = line.needs.filter((id) => list.lines.some((l) => l.id === id && !l.done));
  return unmet.length > 0 ? `waiting on: ${titlesOf(unmet, list).join(', ')}` : 'not started';
}

/** The message Ask the agent fills in, for the person to read, change and send. Holds no typed value. Pure. */
export function askAgentText(line: SetupLine, list: SetupList, run: SetupRunState | undefined, platform: Platform): string {
  const neededBy = list.lines.filter((l) => l.needs.includes(line.id)).map((l) => l.title);
  const about = [
    `I'm setting up this computer (${list.here.name}, ${PLATFORM_NAME[platform]}) to match my other computers in Kestrel. One step on Kestrel's Set up this computer checklist is not done: **${line.title}** (section ${groupTitle(line)}).`,
    neededBy.length > 0 && `It is needed by: ${neededBy.join(', ')}.`,
    line.command && `Kestrel would run \`${line.command.text}\`.`,
    run?.state === 'failed' ? `It failed: "${run.reason}".` : `It is ${lineStateText(line, list, run)}.`,
  ].filter(Boolean).join(' ');
  const output = run?.state === 'failed' && run.output ? `The last output was:\n\`\`\`\n${run.output}\n\`\`\`` : null;
  const ask = 'Read the whole checklist with the `setup_list` tool, work out why this step cannot be done here, and tell me what to do. If it needs no administrator, offer to do it with `setup_run_step` or `setup_run_command`; I answer each on a card.';
  return [about, output, ask].filter(Boolean).join('\n\n');
}

/** The checklist as `setup_list` answers it: every line, its state and needs, no run output and no value. Pure. */
export function setupListText(list: SetupList, runs: SetupRuns): string {
  const out = [`Set up this computer: ${list.here.name}, from ${list.others.map((o) => o.name).join(', ') || 'no other computer yet'}.`];
  for (const group of SETUP_GROUPS) {
    const lines = list.lines.filter((l) => l.group === group.id);
    if (lines.length === 0) continue;
    out.push('', `## ${group.title}`);
    for (const l of lines) {
      const needs = l.needs.length > 0 ? ` Needs: ${l.needs.map((id) => `${id}${list.lines.find((x) => x.id === id)?.done ? ' (met)' : ''}`).join(', ')}.` : '';
      out.push(`- ${l.id} | ${l.title} | ${lineStateText(l, list, runs[l.id])}${l.kind === 'cannot' ? ' | cannot come' : ''}${l.run ? ` | runs: ${l.run}` : ''}`);
      out.push(`  ${l.does}${l.command ? ` Command: ${l.command.text}` : ''}${needs} From: ${l.from.join(', ')}.`);
    }
  }
  if (list.problems.length > 0) out.push('', `Could not read here: ${list.problems.join(' ')}`);
  return out.join('\n');
}

const ADMIN = new Set(['sudo', 'doas', 'pkexec', 'su', 'runas', 'gsudo']);
const WRAPPERS = new Set(['env', 'nice', 'nohup', 'time', 'command', 'exec']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd']);
const ADMIN_WORD = /(^|[\s;&|(`$])(sudo|doas|pkexec|su|runas|gsudo)(\s|$)|administrator privileges|-Verb\s+RunAs/i;
const PASTE = ' Give the person the command to paste into their terminal instead.';

const programName = (word: string) => word.replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();

/** Why a command an agent worked out may not run, or null: it needs an administrator. Pure. */
export function adminCommandRefusal(argv: readonly string[]): string | null {
  if (argv.length === 0 || argv.some((a) => typeof a !== 'string')) return 'Give the command as a list of words: the program, then each argument.';
  // `env A=1 nice -n 5 sudo …`: behind a wrapper, any later word that is an administrator program counts.
  let i = 0;
  while (i < argv.length - 1 && WRAPPERS.has(programName(argv[i]!))) {
    const admin = argv.slice(i + 1).find((a) => ADMIN.has(programName(a)));
    if (admin) return `${programName(admin)} asks for an administrator, which Kestrel never does.${PASTE}`;
    i++;
    while (i < argv.length - 1 && (argv[i]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!) || /^\d+$/.test(argv[i]!))) i++;
  }
  const program = programName(argv[i] ?? '');
  if (ADMIN.has(program)) return `${program} asks for an administrator, which Kestrel never does.${PASTE}`;
  if (program === 'osascript' && argv.some((a) => /administrator privileges/i.test(a))) return `That asks for an administrator, which Kestrel never does.${PASTE}`;
  if (SHELLS.has(program) && argv.slice(i + 1).some((a) => ADMIN_WORD.test(a))) return `That script asks for an administrator, which Kestrel never does.${PASTE}`;
  return null;
}

/** A command as the card shows it: quoted for this platform's shell, exactly as it will run. Pure. */
export function cardCommandText(argv: readonly string[], platform: Platform): string {
  const shell = shellOf(platform);
  return argv.map((a) => quoteArg(a, shell)).join(' ');
}
