// Bringing an agent's files over (docs/designs/onboarding.md, 18.2 and 18.3). The files come from the
// other computer's sealed file record, read only now. Every path is checked as if the record were
// hostile: it must stay inside this home folder after links are followed, inside this agent's own
// folders, and inside the line's own paths. A file that is here and differs is never overwritten
// without asking: the line waits on Replace or Keep, having written nothing. A replaced file is kept
// under Kestrel's data folder, and Undo puts back exactly what was there.
import { join, relative } from 'node:path';
import type { Agent } from '../model.ts';
import { fillBlanks, type FileBlank } from '../shared/setup-files.ts';
import type { SetupAction } from '../shared/setup-list.ts';
import { failed, realHomePath, type ExecuteDeps } from './execute.ts';
import type { StepContext, StepResult } from './steps.ts';

/** The folders each agent keeps its own files in, as `~/…`. A file record may write nowhere else. */
export const AGENT_FOLDERS: Record<Agent, string> = { claude: '~/.claude', codex: '~/.codex', opencode: '~/.config/opencode' };

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** The input key for a value typed for a blank: the file and where in it. */
export const blankKey = (blank: Pick<FileBlank, 'path' | 'at'>): string => `value:${blank.path}:${JSON.stringify(blank.at)}`;

const listed = (paths: readonly string[], max = 3) => (paths.length > max ? `${paths.slice(0, max).join(', ')} and ${paths.length - max} more` : paths.join(', '));

interface Planned {
  path: string;
  full: string;
  text: string;
  before: string | null;
}

export async function filesStep(deps: ExecuteDeps, ctx: StepContext, action: Extract<SetupAction, { kind: 'files' }>): Promise<StepResult> {
  const record = await ctx.files();
  if (!record) return failed(`No other computer holds these files yet. Kestrel on ${ctx.line.from.join(' or ')} writes them when it connects or when its Connections page is opened; then Check again here.`);
  if (record.agent !== action.agent) return failed('These files belong to another agent.');
  const planned: Planned[] = [];
  for (const file of record.files) {
    if (!inside(file.path, AGENT_FOLDERS[action.agent]) || !action.paths.some((p) => inside(file.path, p))) return failed(`${file.path} is not in ${AGENT_FOLDERS[action.agent]}, where this line may write. Nothing was written.`);
    const full = realHomePath(file.path, deps);
    if (!full) return failed(`${file.path} leads outside the home folder. Nothing was written.`);
    const values = Object.fromEntries(record.blanks.filter((b) => b.path === file.path && ctx.input[blankKey(b)]).map((b) => [JSON.stringify(b.at), ctx.input[blankKey(b)]!]));
    const text = fillBlanks(file.path, file.text, values);
    const before = deps.fs.exists(full) ? deps.fs.read(full) : null;
    if (before === text) continue;
    planned.push({ path: file.path, full, text, before });
  }
  const differ = planned.filter((p) => p.before !== null);
  const choice = ctx.input.differ;
  if (differ.length > 0 && choice !== 'replace' && choice !== 'keep') {
    return { state: 'waiting', ask: 'replace-or-keep', on: `you: ${differ.length === 1 ? 'a file here differs' : `${differ.length} files here differ`} from ${ctx.line.from.join(' and ')}: ${listed(differ.map((p) => p.path))}. Replace (yours are kept for Undo) or Keep yours. Nothing was written yet.` };
  }
  const writing = choice === 'keep' ? planned.filter((p) => p.before === null) : planned;
  const backups = join(deps.dataDir, 'setup-backups', String(Date.now()));
  const written: Planned[] = [];
  try {
    for (const p of writing) {
      if (p.before !== null) deps.fs.write(join(backups, relative(deps.home, p.full)), p.before);
      deps.fs.write(p.full, p.text);
      written.push(p);
    }
  } catch (error) {
    await putBack(deps, written);
    return failed(`Could not write ${written.length < writing.length ? writing[written.length]!.path : 'a file'}: ${error instanceof Error ? error.message : String(error)}. What was written was put back.`);
  }
  const replaced = written.filter((p) => p.before !== null).length;
  const kept = choice === 'keep' ? differ.length : 0;
  const unfilled = record.blanks.filter((b) => !ctx.input[blankKey(b)]);
  const said = [
    written.length === 0 ? 'Every file was already here.' : `Wrote ${written.length === 1 ? 'one file' : `${written.length} files`}${replaced ? `, ${replaced} of them replacing yours (copies are in Kestrel's data folder)` : ''}.`,
    kept && `Kept your ${kept === 1 ? 'file' : `${kept} files`} that differ.`,
    record.skipped.length > 0 && `Not brought: ${record.skipped.map((s) => `${s.path} (${s.why})`).join('; ')}.`,
    unfilled.length > 0 && `Left empty, to fill in here: ${[...new Set(unfilled.map((b) => `${b.name} in ${b.path}`))].join(', ')}.`,
  ].filter(Boolean).join(' ');
  return { state: 'done', said, ...(written.length > 0 ? { undo: () => putBack(deps, written) } : {}) };
}

/** Puts back what was there: a replaced file's text, or no file where there was none. */
async function putBack(deps: ExecuteDeps, written: readonly Planned[]): Promise<void> {
  for (const p of [...written].reverse()) {
    if (p.before === null) deps.fs.remove(p.full);
    else deps.fs.write(p.full, p.before);
  }
}
