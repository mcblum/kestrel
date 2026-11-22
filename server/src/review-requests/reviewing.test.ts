// The "Reviewing" comment (reviewing.ts): what counts as one, whose still stands, and what is asked
// of gh and glab. The runner is a stand-in: nothing here calls a host.
import { describe, expect, it } from 'vitest';
import { alreadyReviewing, claimAge, githubClaims, gitlabClaims, REVIEWING_FRESH_MS, REVIEWING_MARK, reviewingComment, reviewingComments, saysReviewing, standingClaims } from './reviewing.ts';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe('what counts as "Reviewing"', () => {
  it('Kestrel’s own comment, which names the commit and carries its mark', () => {
    const body = reviewingComment('abcdef0123456789abcdef');
    expect(body).toMatch(/^Reviewing this now, at commit abcdef012345\./);
    expect(body).toContain(REVIEWING_MARK);
    expect(saysReviewing(body)).toBe(true);
  });

  it('a person’s comment that opens with the word, with or without an emoji before it', () => {
    for (const body of ['Reviewing', 'reviewing now', '👀 Reviewing this', ':eyes: Reviewing', '  Reviewing.\n\nBack in an hour']) expect(saysReviewing(body), body).toBe(true);
  });

  it('not a comment that merely mentions it', () => {
    for (const body of ['Thanks for reviewing!', 'I will be reviewing this tomorrow', 'Reviewed, looks good', 'LGTM', '']) expect(saysReviewing(body), body).toBe(false);
  });
});

describe('reading a request’s comments', () => {
  it('GitHub: who said it and when', () => {
    const json = JSON.stringify([
      { user: { login: 'robin' }, body: 'Reviewing', created_at: ago(30) },
      { user: { login: 'sam' }, body: 'Pushed a fix', created_at: ago(10) },
      { user: { login: 'me' }, body: reviewingComment('c'.repeat(40)), created_at: ago(5) },
    ]);
    expect(githubClaims(json)).toEqual([{ by: 'robin', at: NOW - 30 * 60_000 }, { by: 'me', at: NOW - 5 * 60_000 }]);
    expect(githubClaims('{"message":"Not Found"}')).toEqual([]);
  });

  it('GitLab: the same from notes, never from a system note', () => {
    const json = JSON.stringify([
      { author: { username: 'robin' }, body: 'Reviewing', created_at: ago(30), system: false },
      { author: { username: 'sam' }, body: 'reviewing requested from @me', created_at: ago(40), system: true },
    ]);
    expect(gitlabClaims(json)).toEqual([{ by: 'robin', at: NOW - 30 * 60_000 }]);
  });
});

describe('whose word still stands', () => {
  it('the most recent by somebody else, and the user’s own, apart; names compared without case', () => {
    const claims = [{ by: 'robin', at: NOW - 3_600_000 }, { by: 'Me', at: NOW - 60_000 }, { by: 'alex', at: NOW - 120_000 }];
    expect(standingClaims(claims, 'me', NOW)).toEqual({ other: { by: 'alex', at: NOW - 120_000 }, mine: { by: 'Me', at: NOW - 60_000 } });
  });

  it('a claim older than a day holds nothing: an abandoned review does not block a request for ever', () => {
    expect(standingClaims([{ by: 'robin', at: NOW - REVIEWING_FRESH_MS - 1 }], 'me', NOW)).toEqual({ other: null, mine: null });
    expect(standingClaims([{ by: 'robin', at: NOW - REVIEWING_FRESH_MS + 60_000 }], 'me', NOW).other?.by).toBe('robin');
  });

  it('a claim with no time is taken as standing', () => {
    expect(standingClaims([{ by: 'robin', at: 0 }], 'me', NOW).other).toEqual({ by: 'robin', at: 0 });
  });

  it('says how long ago, and why no second review started', () => {
    expect(claimAge({ by: 'r', at: NOW - 20_000 }, NOW)).toBe('just now');
    expect(claimAge({ by: 'r', at: NOW - 60_000 }, NOW)).toBe('1 minute ago');
    expect(claimAge({ by: 'r', at: NOW - 3 * 3_600_000 }, NOW)).toBe('3 hours ago');
    expect(claimAge({ by: 'r', at: 0 }, NOW)).toBe('recently');
    expect(alreadyReviewing({ by: 'robin', at: NOW - 20 * 60_000 }, NOW)).toMatch(/^robin said they are reviewing this 20 minutes ago, so Kestrel did not start a second review on its own\./);
  });
});

describe('asking the host', () => {
  const calls: [string, readonly string[]][] = [];
  const runner = (answers: Record<string, string>) => async (command: string, args: readonly string[]) => {
    calls.push([command, args]);
    const key = Object.keys(answers).find((k) => args.join(' ').includes(k));
    if (key === undefined) throw new Error(`unexpected ${command} ${args.join(' ')}`);
    return { stdout: answers[key]! };
  };
  const github = { host: 'github' as const, hostName: 'github.com', repository: 'acme/app', number: 7 };
  const gitlab = { host: 'gitlab' as const, hostName: 'gitlab.example.com', repository: 'group/sub/app', number: 9 };

  it('GitHub: only the last day’s comments, then who the user is, once', async () => {
    calls.length = 0;
    const comments = reviewingComments(runner({ 'issues/7/comments': JSON.stringify([{ user: { login: 'robin' }, body: 'Reviewing', created_at: ago(5) }]), 'api user': 'me\n' }), '/');
    expect(await comments.standing(github, NOW)).toEqual({ other: { by: 'robin', at: NOW - 5 * 60_000 }, mine: null });
    expect(calls[0]).toEqual(['gh', ['api', '-X', 'GET', 'repos/acme/app/issues/7/comments', '-F', 'per_page=100', '-f', `since=${new Date(NOW - REVIEWING_FRESH_MS).toISOString()}`]]);
    await comments.standing(github, NOW);
    expect(calls.filter(([, args]) => args.includes('user'))).toHaveLength(1);
  });

  it('nobody has said anything: the user’s name is never asked for', async () => {
    calls.length = 0;
    expect(await reviewingComments(runner({ 'issues/7/comments': '[]' }), '/').standing(github, NOW)).toEqual({ other: null, mine: null });
    expect(calls).toHaveLength(1);
  });

  it('GitLab: the merge request’s notes on its own server, by the project’s full path', async () => {
    calls.length = 0;
    const comments = reviewingComments(runner({ 'merge_requests/9/notes': JSON.stringify([{ author: { username: 'me' }, body: 'Reviewing', created_at: ago(5) }]), 'api user': '{"username":"me"}' }), '/');
    expect((await comments.standing(gitlab, NOW)).mine?.by).toBe('me');
    expect(calls[0]).toEqual(['glab', ['api', 'projects/group%2Fsub%2Fapp/merge_requests/9/notes?sort=desc&order_by=created_at&per_page=100', '--hostname', 'gitlab.example.com']]);
  });

  it('posts the comment as one argument, never through a shell', async () => {
    calls.length = 0;
    await reviewingComments(runner({ 'issues/7/comments': '{}' }), '/').announce(github, 'c'.repeat(40));
    expect(calls[0]![1].slice(0, 5)).toEqual(['api', '-X', 'POST', 'repos/acme/app/issues/7/comments', '-f']);
    expect(calls[0]![1][5]).toBe(`body=${reviewingComment('c'.repeat(40))}`);
    calls.length = 0;
    await reviewingComments(runner({ 'merge_requests/9/notes': '{}' }), '/').announce(gitlab, 'c'.repeat(40));
    expect(calls[0]![1].slice(0, 6)).toEqual(['api', '-X', 'POST', 'projects/group%2Fsub%2Fapp/merge_requests/9/notes', '--hostname', 'gitlab.example.com']);
  });

  it('a host that refuses is an error the caller hears', async () => {
    await expect(reviewingComments(runner({}), '/').standing(github, NOW)).rejects.toThrow(/unexpected gh/);
  });
});
