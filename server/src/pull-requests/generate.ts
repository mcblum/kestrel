// The text "Create PR → Generated" fills the form with. A model writes the title and summary when
// one answers in time (the same providers, in the same order, as session titles; the session's own
// agent is asked with the session's model, any other with its own default); otherwise, or
// when its reply cannot be read, the plain text made from the commit subjects and the diff stat is
// used. The Testing section is never the model's: it is made here from what the commits show, so
// nothing can claim that tests ran.
import { prTextRequest, PR_TEXT_TIMEOUT_MS, type PRMaterial } from '../agents/pr-text-request.ts';
import { providersFor, type TitleProvider } from '../agents/title-providers.ts';
import { sleep } from '../agents/title-request.ts';
import type { Agent } from '../model.ts';

export interface PRText {
  title: string;
  body: string;
}

/** The longest title kept; a longer one is cut at a word. */
export const PR_TITLE_MAX = 70;
/** Shorter than this, a title says nothing. */
const PR_TITLE_MIN = 3;
const NOT_RECORDED = 'Not recorded.';
const TEST_SUBJECT = /\btests?\b|\bspecs?\b/i;

type Wait = (ms: number) => Promise<void>;
type Log = (line: string) => void;

/** Whose text it is: the session's agent and its model (empty or absent means that agent's default). */
export interface PRAuthor {
  agent: Agent;
  model?: string;
}

/** What the commits show about testing: the subjects that mention tests, or "Not recorded." Pure. */
export function testingSection(subjects: readonly string[]): string {
  const tests = subjects.filter((s) => TEST_SUBJECT.test(s));
  return tests.length ? `Commits that touch tests:\n\n${tests.map((s) => `- ${s}`).join('\n')}` : NOT_RECORDED;
}

const bodyOf = (summary: string, subjects: readonly string[]) => `## Summary\n\n${summary}\n\n## Testing\n\n${testingSection(subjects)}`;

/** The title and body made from the commits alone, without a model. Pure. */
export function plainPRText(material: Pick<PRMaterial, 'branch' | 'subjects' | 'stat'>): PRText {
  const { branch, subjects, stat } = material;
  const title = subjects.length === 1 ? subjects[0]! : branch.replace(/^.*\//, '').replace(/[-_]/g, ' ');
  const summary = `${subjects.map((s) => `- ${s}`).join('\n')}\n\n### Changes\n\n\`\`\`text\n${stat}\n\`\`\``;
  return { title: cutTitle(title), body: bodyOf(summary, subjects) };
}

/** A title cut to PR_TITLE_MAX characters at a word boundary. Pure. */
function cutTitle(title: string): string {
  if (title.length <= PR_TITLE_MAX) return title;
  const cut = title.slice(0, PR_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > PR_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The title line as the model wrote it, without the decoration the instruction forbade. */
function cleanTitleLine(line: string): string {
  return line.replace(/^#+\s*/, '').replace(/^title:\s*/i, '').replace(/^["'`*]+|["'`*]+$/g, '').replace(/[.]+$/, '').trim();
}

/**
 * The model's reply as a title and body, or null when it is not one: no title line, a title too
 * short, or no summary under it. Any testing section it wrote is dropped. Pure.
 */
export function parsePRTextReply(raw: string, subjects: readonly string[]): PRText | null {
  const lines = raw.replace(/\r\n/g, '\n').trim().split('\n');
  const title = cleanTitleLine(lines[0] ?? '');
  if (title.length < PR_TITLE_MIN || title.includes('<')) return null;
  const rest = lines.slice(1).join('\n');
  const testing = rest.search(/^#{0,6}\s*\**testing\b/im);
  const summary = (testing >= 0 ? rest.slice(0, testing) : rest).replace(/^\s*#{1,6}\s*summary\s*$/im, '').trim();
  if (!summary) return null;
  return { title: cutTitle(title), body: bodyOf(summary, subjects) };
}

/** Asks the providers in turn; the first readable reply wins. Null when none gives one. */
async function firstReadable(writers: readonly TitleProvider[], material: PRMaterial, author: PRAuthor, log: Log): Promise<PRText | null> {
  const request = prTextRequest(material);
  for (const writer of writers) {
    if (!writer.pullRequestText) continue;
    // The session's model only means something to its own agent; another keeps its default.
    const model = writer.agent === author.agent && author.model ? author.model : undefined;
    try {
      const raw = await writer.pullRequestText(request, model);
      const text = raw === null ? null : parsePRTextReply(raw, material.subjects);
      if (text) return text;
      log(`${writer.name}: ${raw === null ? 'no reply' : 'unusable reply'} for a pull request's text`);
    } catch (error) {
      log(`${writer.name}: ${error instanceof Error ? error.message : String(error)} (pull request text)`);
    }
  }
  return null;
}

/**
 * The text for a generated pull request: the model's when one answers within PR_TEXT_TIMEOUT_MS
 * (`wait` is that clock; tests pass one), else the plain text. Never throws.
 */
export async function writePRText(material: PRMaterial, writers: readonly TitleProvider[], author: PRAuthor, wait: Wait = sleep, log: Log = (line) => console.log(`[kestrel] ${line}`)): Promise<PRText> {
  const ordered = providersFor(writers, author.agent).filter((w) => w.pullRequestText);
  if (ordered.length === 0) return plainPRText(material);
  const written = await Promise.race([firstReadable(ordered, material, author, log), wait(PR_TEXT_TIMEOUT_MS).then(() => null)]);
  if (!written) log('no generated pull request text (none answered in time, or no readable reply); using the commit subjects');
  return written ?? plainPRText(material);
}
