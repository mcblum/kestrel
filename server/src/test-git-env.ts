// Every test runs git without the user's own git configuration. A developer's global config can
// sign every commit with gpg (commit.gpgsign), run hooks or set a template; under a loaded machine
// the signing agent is slow or refuses, `git commit` in a test repository fails, and a test fails
// for a reason that has nothing to do with Kestrel. An empty global config and no system config
// make git behave the same on every machine; the identity commits need is given here instead.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptyConfig = join(mkdtempSync(join(tmpdir(), 'kestrel-gitconfig-')), 'gitconfig');
writeFileSync(emptyConfig, '');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Kestrel Test',
  GIT_AUTHOR_EMAIL: 'test@kestrel.invalid',
  GIT_COMMITTER_NAME: 'Kestrel Test',
  GIT_COMMITTER_EMAIL: 'test@kestrel.invalid',
});
