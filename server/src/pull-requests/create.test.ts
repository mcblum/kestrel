// Creating a pull request: the form's checks, the pre-fill (blank, or written from the commits by a
// model with the plain text as the fallback; from the session's recorded start when there is one,
// with the inherited commits counted), and publishing (push, then gh pr create). Every command goes
// to a stand-in runner, so nothing reaches gh, git push or a model.
import { describe, expect, it } from 'vitest';
import type { TitleProvider } from '../agents/title-providers.ts';
import { PR_DIFF_BUDGET_BYTES, PR_TEXT_TIMEOUT_MS } from '../agents/pr-text-request.ts';
import { preparePR, publishPR, validatePRForm } from './create.ts';
import type { CommandRunner } from './types.ts';

type Call = { bin: string; args: readonly string[]; cwd: string };

/** A runner that answers from `answers` by "bin arg arg…", records every call, and fails on anything else. */
function fakeRunner(answers: Record<string, string | Error>) {
  const calls: Call[] = [];
  const run: CommandRunner = async (bin, args, { cwd }) => {
    calls.push({ bin, args, cwd });
    const answer = answers[[bin, ...args].join(' ')];
    if (answer === undefined) throw new Error(`unexpected command: ${bin} ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { run, calls };
}

const REPO_VIEW = 'gh repo view --json defaultBranchRef';
const CONFIG = 'git config --get branch.feat/x.kestrelbase';
/** What git config says for a key that is not set: it exits 1 with nothing on stdout. */
const UNSET = new Error('Command failed: git config --get branch.feat/x.kestrelbase');
const LOG = 'git log --format=%s origin/main..feat/x --';
const STAT = 'git diff --stat origin/main...feat/x --';
const DIFF = 'git diff --no-color --no-ext-diff origin/main...feat/x --';
const generatedAnswers = (diff: string | Error = 'diff --git a/a.ts b/a.ts\n+one') => ({
  [REPO_VIEW]: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
  [CONFIG]: UNSET,
  [LOG]: 'feat: cache search results\ntest: cover the cache',
  [STAT]: ' a.ts | 1 +\n 1 file changed',
  [DIFF]: diff,
});
const never = () => new Promise<void>(() => undefined);
const writer = (reply: () => Promise<string | null>, asked: string[] = [], agent: 'claude' | 'codex' = 'claude', name = agent, models: (string | undefined)[] = []): TitleProvider => ({
  name,
  agent,
  title: async () => null,
  pullRequestText: (request, model) => (asked.push(request), models.push(model), reply()),
});

// A session that started on another unmerged branch: its recorded start is that branch's head.
const START = 'abc1234def5678';
const OWN_LOG = `git log --format=%s ${START}..feat/x --`;
const OWN_STAT = `git diff --stat ${START}..feat/x --`;
const OWN_DIFF = `git diff --no-color --no-ext-diff ${START}..feat/x --`;
const COUNT = `git rev-list --count origin/main..${START} --`;
const sessionAnswers = (over: Record<string, string | Error> = {}) => ({
  [REPO_VIEW]: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
  [CONFIG]: START,
  [COUNT]: '5',
  [OWN_LOG]: 'docs: explain the setup in the README',
  [OWN_STAT]: ' README.md | 4 ++++\n 1 file changed',
  [OWN_DIFF]: 'diff --git a/README.md b/README.md\n+setup',
  ...over,
});

describe('validatePRForm', () => {
  const ok = { title: '  Make search instant ', body: 'Body', base: ' main ', draft: false };
  it('accepts a complete form, trimming the title and base', () => {
    expect(validatePRForm(ok)).toEqual({ title: 'Make search instant', body: 'Body', base: 'main', draft: false });
    expect(validatePRForm({ ...ok, base: 'release/2026-11', draft: true })).toMatchObject({ base: 'release/2026-11', draft: true });
  });
  it('refuses each missing or bad field with what to fix', () => {
    expect(() => validatePRForm({ ...ok, title: '   ' })).toThrow(/Enter a title/);
    expect(() => validatePRForm({ ...ok, title: 'x'.repeat(257) })).toThrow(/Enter a title/);
    expect(() => validatePRForm({ ...ok, title: 3 })).toThrow(/Enter a title/);
    expect(() => validatePRForm({ ...ok, body: 'x'.repeat(65_001) })).toThrow(/Description/);
    expect(() => validatePRForm({ ...ok, body: undefined })).toThrow(/Description/);
    expect(() => validatePRForm({ ...ok, base: '' })).toThrow(/base branch/);
    expect(() => validatePRForm({ ...ok, base: 'two words' })).toThrow(/base branch/);
    expect(() => validatePRForm({ ...ok, base: 'a..b' })).toThrow(/base branch/);
    expect(() => validatePRForm({ ...ok, draft: 'yes' })).toThrow(/draft/);
  });
  it('refuses a base that starts with a dash, so it can never be read as an option', () => {
    expect(() => validatePRForm({ ...ok, base: '--force' })).toThrow(/base branch/);
    expect(() => validatePRForm({ ...ok, base: ' -main' })).toThrow(/base branch/);
  });
  it('refuses a description that is only a dash, which gh and glab read as "from elsewhere"', () => {
    expect(() => validatePRForm({ ...ok, body: ' - ' })).toThrow(/description/);
    expect(validatePRForm({ ...ok, body: '- one item' }).body).toBe('- one item');
  });
});

describe('preparePR', () => {
  it('manually: the default branch from gh and the session\'s recorded start (none here), blank text', async () => {
    const { run, calls } = fakeRunner({ [REPO_VIEW]: JSON.stringify({ defaultBranchRef: { name: 'trunk' } }), [CONFIG]: UNSET });
    expect(await preparePR('/repo', 'feat/x', false, { run })).toEqual({ title: '', body: '', base: 'trunk', draft: false, inherited: 0 });
    expect(calls).toEqual([
      { bin: 'gh', args: ['repo', 'view', '--json', 'defaultBranchRef'], cwd: '/repo' },
      { bin: 'git', args: ['config', '--get', 'branch.feat/x.kestrelbase'], cwd: '/repo' },
    ]);
  });

  it('manually with a recorded start: one more command, to count the inherited commits', async () => {
    const { run, calls } = fakeRunner(sessionAnswers());
    expect(await preparePR('/repo', 'feat/x', false, { run })).toEqual({ title: '', body: '', base: 'main', draft: false, inherited: 5 });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['gh', 'repo', 'view', '--json', 'defaultBranchRef'],
      ['git', 'config', '--get', 'branch.feat/x.kestrelbase'],
      ['git', 'rev-list', '--count', `origin/main..${START}`, '--'],
    ]);
  });

  it('says so when gh has no default branch', async () => {
    const { run } = fakeRunner({ [REPO_VIEW]: '{}' });
    await expect(preparePR('/repo', 'feat/x', false, { run })).rejects.toThrow(/default branch/);
  });

  it('generated without a model: the plain text from the commits, with exact git arguments', async () => {
    const { run, calls } = fakeRunner(generatedAnswers());
    const out = await preparePR('/repo', 'feat/x', true, { run });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['gh', 'repo', 'view', '--json', 'defaultBranchRef'],
      ['git', 'config', '--get', 'branch.feat/x.kestrelbase'],
      ['git', 'log', '--format=%s', 'origin/main..feat/x', '--'],
      ['git', 'diff', '--stat', 'origin/main...feat/x', '--'],
      ['git', 'diff', '--no-color', '--no-ext-diff', 'origin/main...feat/x', '--'],
    ]);
    expect(out.title).toBe('x');
    expect(out.base).toBe('main');
    expect(out.inherited).toBe(0);
    expect(out.body).toContain('## Summary\n\n- feat: cache search results\n- test: cover the cache');
    expect(out.body).toContain(' 1 file changed');
    expect(out.body).toContain('## Testing\n\nCommits that touch tests:\n\n- test: cover the cache');
  });

  it('refuses to generate from a branch with no commits beyond the default branch', async () => {
    const { run } = fakeRunner({ ...generatedAnswers(), [LOG]: '' });
    await expect(preparePR('/repo', 'feat/x', true, { run })).rejects.toThrow(/no commits/);
  });

  it('uses the model’s title and summary, and writes Testing itself', async () => {
    const asked: string[] = [];
    const { run } = fakeRunner(generatedAnswers());
    const reply = 'Title: "Cache search results."\n\n## Summary\n- Search answers come from a cache\n\n## Testing\n- All tests pass';
    const out = await preparePR('/repo', 'feat/x', true, { run, writers: [writer(async () => reply, asked)], wait: never });
    expect(out.title).toBe('Cache search results');
    expect(out.body).toBe('## Summary\n\n- Search answers come from a cache\n\n## Testing\n\nCommits that touch tests:\n\n- test: cover the cache');
    expect(out.body).not.toContain('All tests pass');
    expect(asked[0]).toContain('<commits>\nfeat: cache search results\ntest: cover the cache\n</commits>');
    expect(asked[0]).toContain('<diffstat>\na.ts | 1 +\n 1 file changed\n</diffstat>');
    expect(asked[0]).toContain('+one');
  });

  it('shows the model the diff cut to the byte budget', async () => {
    const asked: string[] = [];
    const { run } = fakeRunner(generatedAnswers(`+${'é'.repeat(PR_DIFF_BUDGET_BYTES)}`));
    await preparePR('/repo', 'feat/x', true, { run, writers: [writer(async () => 'Short title here\n\n- One', asked)], wait: never });
    const diff = /<diff>\n([\s\S]*)\n<\/diff>/.exec(asked[0]!)![1]!;
    expect(Buffer.byteLength(diff.replace('\n[diff cut short]', ''), 'utf8')).toBeLessThanOrEqual(PR_DIFF_BUDGET_BYTES);
    expect(diff).toContain('[diff cut short]');
    expect(diff).not.toContain('�');
  });

  it('falls back to the plain text when the model does not answer in time', async () => {
    const waited: number[] = [];
    const { run } = fakeRunner(generatedAnswers());
    const out = await preparePR('/repo', 'feat/x', true, { run, writers: [writer(() => new Promise(() => undefined))], wait: async (ms) => void waited.push(ms) });
    expect(waited).toEqual([PR_TEXT_TIMEOUT_MS]);
    expect(out.title).toBe('x');
    expect(out.body).toContain('- feat: cache search results');
  });

  it('falls back on a junk reply or an error, after trying the session’s own agent first', async () => {
    const order: string[] = [];
    const { run } = fakeRunner(generatedAnswers());
    const writers = [
      writer(async () => (order.push('claude'), '<<<'), [], 'claude'),
      writer(async () => {
        order.push('codex');
        throw new Error('not signed in');
      }, [], 'codex'),
    ];
    const out = await preparePR('/repo', 'feat/x', true, { run, writers, agent: 'codex', wait: never });
    expect(order).toEqual(['codex', 'claude']);
    expect(out.title).toBe('x');
  });

  it('still writes the text when the diff itself cannot be read', async () => {
    const { run } = fakeRunner(generatedAnswers(new Error('maxBuffer exceeded')));
    expect((await preparePR('/repo', 'feat/x', true, { run })).body).toContain('## Summary');
  });

  it('with a recorded start: only the session\'s own commits, two-dot ranges, exact git arguments', async () => {
    const asked: string[] = [];
    const { run, calls } = fakeRunner(sessionAnswers());
    const out = await preparePR('/repo', 'feat/x', true, { run, writers: [writer(async () => 'Explain the setup\n\n- README says how', asked)], wait: never });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['gh', 'repo', 'view', '--json', 'defaultBranchRef'],
      ['git', 'config', '--get', 'branch.feat/x.kestrelbase'],
      ['git', 'rev-list', '--count', `origin/main..${START}`, '--'],
      ['git', 'log', '--format=%s', `${START}..feat/x`, '--'],
      ['git', 'diff', '--stat', `${START}..feat/x`, '--'],
      ['git', 'diff', '--no-color', '--no-ext-diff', `${START}..feat/x`, '--'],
    ]);
    expect(out).toMatchObject({ title: 'Explain the setup', base: 'main', inherited: 5 });
    expect(asked[0]).toContain('<commits>\ndocs: explain the setup in the README\n</commits>');
    expect(asked[0]).toContain('+setup');
  });

  it('with a recorded start and nothing committed since: says so, never asks a model, never uses the inherited commits', async () => {
    const asked: string[] = [];
    const { run, calls } = fakeRunner(sessionAnswers({ [OWN_LOG]: '' }));
    await expect(preparePR('/repo', 'feat/x', true, { run, writers: [writer(async () => 'Title here\n\n- One', asked)], wait: never })).rejects.toThrow(
      "Nothing is committed on this branch yet. Commit this session's changes, then generate the text.",
    );
    expect(asked).toEqual([]);
    expect(calls.some((c) => c.args.some((a) => a.startsWith('origin/main..feat/x') || a.startsWith('origin/main...')))).toBe(false);
  });

  it('ignores a recorded start that is not a commit hash, and keeps the origin ranges', async () => {
    for (const value of ['HEAD~3', 'abc', '--all', 'g'.repeat(40), 'a'.repeat(65)]) {
      const { run, calls } = fakeRunner({ ...generatedAnswers(), [CONFIG]: value });
      const out = await preparePR('/repo', 'feat/x', true, { run });
      expect(out.inherited).toBe(0);
      expect(calls.map((c) => c.args.join(' '))).toEqual(['repo view --json defaultBranchRef', 'config --get branch.feat/x.kestrelbase', 'log --format=%s origin/main..feat/x --', 'diff --stat origin/main...feat/x --', 'diff --no-color --no-ext-diff origin/main...feat/x --']);
    }
  });

  it('counts no inherited commits when git cannot count them', async () => {
    for (const answer of [new Error('unknown revision origin/main'), '', 'many']) {
      const { run } = fakeRunner(sessionAnswers({ [COUNT]: answer }));
      expect((await preparePR('/repo', 'feat/x', false, { run })).inherited).toBe(0);
      expect((await preparePR('/repo', 'feat/x', true, { run })).inherited).toBe(0);
    }
  });

  it('asks the session\'s own agent with the session\'s model, and another agent with its default', async () => {
    const order: string[] = [];
    const claudeModels: (string | undefined)[] = [];
    const codexModels: (string | undefined)[] = [];
    const { run } = fakeRunner(generatedAnswers());
    const writers = [
      writer(async () => (order.push('claude'), 'Cache search results\n\n- One'), [], 'claude', 'claude', claudeModels),
      writer(async () => (order.push('codex'), '<<<'), [], 'codex', 'codex', codexModels),
    ];
    await preparePR('/repo', 'feat/x', true, { run, writers, agent: 'codex', model: 'gpt-5.2-codex', wait: never });
    expect(order).toEqual(['codex', 'claude']);
    expect(codexModels).toEqual(['gpt-5.2-codex']);
    expect(claudeModels).toEqual([undefined]);
  });

  it('passes no model when the session uses its agent\'s default', async () => {
    const models: (string | undefined)[] = [];
    const { run } = fakeRunner(generatedAnswers());
    await preparePR('/repo', 'feat/x', true, { run, writers: [writer(async () => 'Cache search results\n\n- One', [], 'claude', 'claude', models)], agent: 'claude', model: '', wait: never });
    expect(models).toEqual([undefined]);
  });
});

describe('publishPR', () => {
  const form = { title: 'Make search instant', body: 'Body text', base: 'main', draft: false };
  const LIST = 'gh pr list --head=feat/x --state=open --json url';
  const PUSH = 'git push --set-upstream origin refs/heads/feat/x:refs/heads/feat/x';
  const CREATE = 'gh pr create --head=feat/x --base=main --title=Make search instant --body=Body text';

  it('returns an open pull request for the branch without pushing', async () => {
    const { run, calls } = fakeRunner({ [LIST]: JSON.stringify([{ url: 'https://github.com/o/r/pull/9' }]) });
    expect(await publishPR('/repo', 'feat/x', form, { run })).toEqual({ url: 'https://github.com/o/r/pull/9' });
    expect(calls).toHaveLength(1);
  });

  it('otherwise pushes the branch, then creates the pull request', async () => {
    const { run, calls } = fakeRunner({ [LIST]: '[]', [PUSH]: '', [CREATE]: 'Creating pull request…\nhttps://github.com/o/r/pull/10' });
    expect(await publishPR('/repo', 'feat/x', form, { run })).toEqual({ url: 'https://github.com/o/r/pull/10' });
    expect(calls.map((c) => [c.bin, ...c.args])).toEqual([
      ['gh', 'pr', 'list', '--head=feat/x', '--state=open', '--json', 'url'],
      ['git', 'push', '--set-upstream', 'origin', 'refs/heads/feat/x:refs/heads/feat/x'],
      ['gh', 'pr', 'create', '--head=feat/x', '--base=main', '--title=Make search instant', '--body=Body text'],
    ]);
  });

  it('adds --draft only when asked', async () => {
    const { run, calls } = fakeRunner({ [LIST]: '[]', [PUSH]: '', [`${CREATE} --draft`]: 'https://github.com/o/r/pull/11' });
    expect(await publishPR('/repo', 'feat/x', { ...form, draft: true }, { run })).toEqual({ url: 'https://github.com/o/r/pull/11' });
    expect(calls.at(-1)!.args.at(-1)).toBe('--draft');
  });

  it('does not create the pull request when the push fails', async () => {
    const { run, calls } = fakeRunner({ [LIST]: '[]', [PUSH]: new Error('rejected') });
    await expect(publishPR('/repo', 'feat/x', form, { run })).rejects.toThrow('rejected');
    expect(calls.map((c) => c.args[0])).toEqual(['pr', 'push']);
  });
});
