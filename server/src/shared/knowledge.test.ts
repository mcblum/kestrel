import { describe, expect, it } from 'vitest';
import {
  appliesTo, entryIdOf, entryProblem, indexText, isStale, KNOWLEDGE_BODY_MAX, likelySecret, parseEntry, parseManifest,
  proposalBranch, renderEntry, repositoryKey, sameTopic, searchIndex, slugFor, type KnowledgeIndexEntry,
} from './knowledge.ts';

const entry = (id: string, over: Partial<KnowledgeIndexEntry> = {}): KnowledgeIndexEntry => ({
  id, area: id.split('/')[0]!, title: `Title of ${id}`, summary: `Summary of ${id}`, scope: 'all', owner: 'platform', verified: '2026-11-01', ...over,
});

// Made of parts, so no line of this file has the shape of a real token.
const FAKE_TOKEN = `glpat-${'ABCDEFGHIJK'.repeat(2)}`;

const FILE = `---
title: How a deploy reaches production
summary: The path from merge to live, and who can stop it.
scope: github.com/acme/api, github.com/acme/web
owner: team-platform
verified: 2026-11-20
---

A merge to main builds an image.
`;

describe('the knowledge base manifest', () => {
  it('reads version 1 with a name', () => {
    expect(parseManifest('{"version":1,"name":" Acme platform "}')).toEqual({ ok: true, value: { version: 1, name: 'Acme platform' } });
  });
  it('refuses anything else with the reason', () => {
    expect(parseManifest('nope')).toMatchObject({ ok: false, reason: expect.stringMatching(/not valid JSON/) });
    expect(parseManifest('{"version":2,"name":"x"}')).toMatchObject({ ok: false, reason: expect.stringMatching(/reads version 1/) });
    expect(parseManifest('{"version":1}')).toMatchObject({ ok: false, reason: expect.stringMatching(/needs a "name"/) });
  });
});

describe('a repository key', () => {
  it('is the same however the remote is written', () => {
    const key = 'github.com/acme/api';
    expect(repositoryKey('git@github.com:Acme/api.git')).toBe(key);
    expect(repositoryKey('https://github.com/acme/api')).toBe(key);
    expect(repositoryKey('https://user:secret@github.com/acme/api.git/')).toBe(key);
    expect(repositoryKey('ssh://git@github.com:2222/acme/api.git')).toBe(key);
  });
  it('is null for no remote or one that is not an address', () => {
    expect(repositoryKey(null)).toBeNull();
    expect(repositoryKey('not a remote')).toBeNull();
  });
});

describe('an entry file', () => {
  it('is read from entries/<area>/<name>.md', () => {
    expect(parseEntry('entries/platform/deploys.md', FILE)).toEqual({
      ok: true,
      value: {
        id: 'platform/deploys', area: 'platform', title: 'How a deploy reaches production', summary: 'The path from merge to live, and who can stop it.',
        scope: ['github.com/acme/api', 'github.com/acme/web'], owner: 'team-platform', verified: '2026-11-20', body: 'A merge to main builds an image.',
      },
    });
  });
  it('is written back as the same file', () => {
    const read = parseEntry('entries/platform/deploys.md', FILE);
    if (!read.ok) throw new Error(read.reason);
    expect(renderEntry(read.value)).toBe(FILE);
  });
  it('is not an entry anywhere else, or with a name that is not lower-case and hyphenated', () => {
    expect(entryIdOf('entries/platform/deploys.md')).toBe('platform/deploys');
    expect(entryIdOf('entries/deploys.md')).toBeNull();
    expect(entryIdOf('entries/platform/sub/deploys.md')).toBeNull();
    expect(entryIdOf('entries/Platform/Deploys.md')).toBeNull();
    expect(entryIdOf('README.md')).toBeNull();
  });
  it('is refused with what is wrong', () => {
    const bad = (text: string) => parseEntry('entries/a/b.md', text);
    expect(bad('no header')).toMatchObject({ ok: false, reason: expect.stringMatching(/does not start with a header/) });
    expect(bad(FILE.replace('owner: team-platform\n', ''))).toMatchObject({ ok: false, reason: 'The header has no owner.' });
    expect(bad(FILE.replace('2026-11-20', 'last week'))).toMatchObject({ ok: false, reason: expect.stringMatching(/YYYY-MM-DD/) });
    expect(bad(FILE.replace(/scope: .*/, 'scope: all, github.com/acme/api'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not both/) });
    expect(bad(FILE.replace(/scope: .*/, 'scope: api'))).toMatchObject({ ok: false, reason: expect.stringMatching(/host\/owner\/name/) });
    expect(bad(FILE + 'x'.repeat(KNOWLEDGE_BODY_MAX))).toMatchObject({ ok: false, reason: expect.stringMatching(/Split it into two entries/) });
  });
  it('holds a summary to one line of a set length', () => {
    const fields = { title: 'T', summary: 's'.repeat(161), scope: 'all' as const, owner: 'o', verified: '2026-11-20', body: 'b' };
    expect(entryProblem(fields)).toMatch(/summary is 161 characters; at most 160/);
    expect(entryProblem({ ...fields, summary: 'a\nb' })).toMatch(/one line each/);
    expect(entryProblem({ ...fields, summary: 'fine' })).toBeNull();
  });
});

describe('the index a session is handed', () => {
  const api = ['github.com/acme/api'];
  it("lists the session's own repository first, then what applies everywhere, and counts the rest", () => {
    const index = [entry('general/oncall'), entry('api/auth', { scope: api }), entry('web/build', { scope: ['github.com/acme/web'] })];
    expect(indexText(index, api)).toBe([
      '- api/auth: Title of api/auth. Summary of api/auth',
      '- general/oncall: Title of general/oncall. Summary of general/oncall',
      '- 1 more are about other repositories.',
    ].join('\n'));
  });
  it('never grows past its cap: what does not fit is counted by area', () => {
    const index = [
      ...Array.from({ length: 300 }, (_, i) => entry(`platform/e${i}`)),
      ...Array.from({ length: 200 }, (_, i) => entry(`data/e${i}`)),
    ];
    const text = indexText(index, api, 40);
    expect(text.split('\n')).toHaveLength(41);
    expect(text.split('\n').at(-1)).toBe('- 460 more that apply here are not listed, by area: platform (280), data (180).');
  });
  it('shows every area when not everything fits, not only the ones that sort first', () => {
    const index = ['alpha', 'beta', 'gamma'].flatMap((area) => Array.from({ length: 10 }, (_, i) => entry(`${area}/e${i}`)));
    const lines = indexText(index, api, 6).split('\n');
    expect(lines.slice(0, 6).map((l) => l.split(':')[0])).toEqual(['- alpha/e0', '- alpha/e1', '- beta/e0', '- beta/e1', '- gamma/e0', '- gamma/e1']);
    expect(lines[6]).toBe('- 24 more that apply here are not listed, by area: alpha (8), beta (8), gamma (8).');
  });
  it('is empty for an empty knowledge base', () => {
    expect(indexText([], api)).toBe('');
  });
  it('applies an entry by its scope', () => {
    expect(appliesTo(entry('a/b'), [])).toBe(true);
    expect(appliesTo(entry('a/b', { scope: api }), api)).toBe(true);
    expect(appliesTo(entry('a/b', { scope: api }), ['github.com/acme/web'])).toBe(false);
  });
});

describe('searching the index', () => {
  const api = ['github.com/acme/api'];
  const index = [
    entry('platform/deploys', { title: 'How a deploy reaches production', summary: 'From merge to live.' }),
    entry('api/deploy-keys', { title: 'Deploy keys for the API', summary: 'Where they are kept.', scope: api }),
    entry('data/warehouse', { title: 'The warehouse', summary: 'Nightly loads.' }),
  ];
  it('ranks a title match first and prefers the caller’s own repository', () => {
    expect(searchIndex(index, 'deploy', api).map((e) => e.id)).toEqual(['api/deploy-keys', 'platform/deploys']);
  });
  it('finds an entry by words only its body holds, last', () => {
    expect(searchIndex(index, 'deploy rollback', api, new Set(['data/warehouse'])).map((e) => e.id)).toEqual(['api/deploy-keys', 'platform/deploys', 'data/warehouse']);
  });
  it('returns nothing for no words, and no more than asked', () => {
    expect(searchIndex(index, ' - ', api)).toEqual([]);
    expect(searchIndex(index, 'deploy', api, new Set(), 1)).toHaveLength(1);
  });
});

describe('a proposal', () => {
  it('meets an existing entry on the same topic', () => {
    const index = [entry('platform/deploys', { title: 'How a deploy reaches production' })];
    expect(sameTopic(index, 'How a deploy reaches production?')?.id).toBe('platform/deploys');
    expect(sameTopic(index, 'How a deploy reaches the production cluster')?.id).toBe('platform/deploys');
    expect(sameTopic(index, 'Rotating the signing key')).toBeUndefined();
  });
  it('names its file and its branch from the title', () => {
    expect(slugFor('  How a Deploy reaches production! ')).toBe('how-a-deploy-reaches-production');
    expect(proposalBranch('platform/deploys')).toBe('knowledge/platform-deploys');
  });
  it('is checked for what looks like a secret', () => {
    expect(likelySecret('The key is kept in the vault under ci/deploy.')).toBeNull();
    expect(likelySecret(`use ${FAKE_TOKEN}`)).toBe('an access token');
    expect(likelySecret('password: hunter2hunter2')).toBe('a password or key written out');
    expect(likelySecret('postgres://app:s3cretpw@db.internal/app')).toBe('credentials inside an address');
    expect(likelySecret(['-----BEGIN', 'OPENSSH', 'PRIVATE KEY-----'].join(' '))).toBe('a private key');
  });
  it('lets a placeholder through: the shape of a credential is not its value', () => {
    expect(likelySecret('SMTP_URL=smtp://sender%40example.test:<pw>@mail.example.test:587')).toBeNull();
    expect(likelySecret('postgres://app:$DB_PASSWORD@db.internal/app')).toBeNull();
    expect(likelySecret('password: <from the keychain item app-mail>')).toBeNull();
    expect(likelySecret('token = ${CI_JOB_TOKEN}')).toBeNull();
  });
});

describe('an entry nobody re-verified', () => {
  it('is stale after 180 days', () => {
    expect(isStale({ verified: '2026-11-01' }, '2026-11-25')).toBe(false);
    expect(isStale({ verified: '2026-05-01' }, '2026-11-25')).toBe(true);
  });
});
