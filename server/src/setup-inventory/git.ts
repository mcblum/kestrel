// Git identity and how commits are signed, as git resolves them outside any repository (the global
// and system settings), through the same reader commit signing uses (`commit-signing/detect.ts`).
// SSH: `~/.ssh/config` is read for its hosts, and the names of the files in `~/.ssh` are listed;
// no key file is ever opened.
import { join } from 'node:path';
import { signingConfig } from '../commit-signing/detect.ts';
import type { MachineInventory } from '../shared/setup-record.ts';
import type { FsRead, Run } from './io.ts';

/** Files in `~/.ssh` that are not keys and not worth naming. */
const NOT_KEYS = new Set(['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment', 'rc']);

export async function readGit(run: Run, home: string): Promise<MachineInventory['git']> {
  const asString = async (file: string, args: readonly string[], cwd?: string) => {
    const answer = await run(file, args, cwd);
    return answer && answer.code === 0 ? answer.stdout : null;
  };
  const value = async (key: string) => (await asString('git', ['config', '--global', '--get', key]))?.trim() || null;
  const [name, email, signing] = await Promise.all([value('user.name'), value('user.email'), signingConfig(asString, home)]);
  return { name, email, signs: signing.signs, format: signing.signs ? signing.format : null, signingKey: signing.signingKey };
}

export function readSsh(fs: FsRead, home: string): MachineInventory['ssh'] {
  const dir = join(home, '.ssh');
  return {
    config: fs.text(join(dir, 'config')),
    keyFiles: fs
      .list(dir)
      .filter((e) => !e.dir && !NOT_KEYS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(),
  };
}
