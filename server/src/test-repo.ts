import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway git repository with one commit. Three git processes, not five: no template is copied
 * (`--template=`: no sample hooks), and the identity comes with the commit (later commits get it from
 * test-git-env.ts, which also keeps the developer's global config, and its commit signing, out).
 */
export function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kestrel-git-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main', '--template=');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'first');
  return dir;
}
