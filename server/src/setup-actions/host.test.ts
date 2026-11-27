// What decides an install's route here (host.ts), for each platform, from what is on disk.
import { describe, expect, it } from 'vitest';
import { installHostOf } from './host.ts';

const at = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;

describe('the install facts of this computer', () => {
  it('a Mac with Homebrew, and npm in a folder the user owns', () => {
    expect(installHostOf('mac', at({ brew: '/opt/homebrew/bin/brew', npm: '/Users/me/.nvm/versions/node/v22/bin/npm' }), {}, (p) => p.startsWith('/Users/me'))).toEqual({ brew: true, npmUser: true, polkit: false, packager: null });
    expect(installHostOf('mac', at({ npm: '/usr/local/bin/npm' }), {}, () => false)).toMatchObject({ brew: false, npmUser: false });
  });

  it('Linux: polkit only with a desktop, and the package manager there is', () => {
    expect(installHostOf('linux', at({ pkexec: '/usr/bin/pkexec', 'apt-get': '/usr/bin/apt-get' }), { DISPLAY: ':0' })).toMatchObject({ polkit: true, packager: 'apt' });
    expect(installHostOf('linux', at({ pkexec: '/usr/bin/pkexec', dnf: '/usr/bin/dnf' }), {})).toMatchObject({ polkit: false, packager: 'dnf' });
  });
});
