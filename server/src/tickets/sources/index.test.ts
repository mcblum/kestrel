// How Settings → Tickets shows each source. A copy on sample data asks nothing and says so once.
import { describe, expect, it } from 'vitest';
import { SAMPLE_SOURCE_LINE, ticketSources } from './index.ts';

const never = () => {
  throw new Error('a copy on sample data asks no tracker');
};

describe('the sources on sample data', () => {
  it('are all sample, with the one line, and nothing is asked', async () => {
    const sources = ticketSources({ fake: true, workspace: { state: never } as never, originOf: never, glabSignIn: never, githubLogin: never, jira: never, linear: never });
    const status = await sources.status();
    expect(status.map((s) => [s.id, s.state])).toEqual([['gitlab', 'sample'], ['github', 'sample'], ['jira', 'sample'], ['linear', 'sample']]);
    expect(new Set(status.map((s) => s.line))).toEqual(new Set([SAMPLE_SOURCE_LINE]));
  });
});
