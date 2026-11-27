import { describe, expect, test } from 'vitest';
import { agreed, confirmDataPrompt, confirmUninstallPrompt, farewellLines, hasUnsavedWork, leftText, unsavedWorkRefusal, type WorktreeWork } from './node-uninstall.ts';

const work = (title: string, uncommitted: number, unpushed: number): WorktreeWork => ({ sessionId: title.toLowerCase(), title, uncommitted, unpushed });

describe('unsaved work', () => {
  test('uncommitted files or commits no remote has are work; neither is none', () => {
    expect(hasUnsavedWork({ uncommitted: 1, unpushed: 0 })).toBe(true);
    expect(hasUnsavedWork({ uncommitted: 0, unpushed: 3 })).toBe(true);
    expect(hasUnsavedWork({ uncommitted: 0, unpushed: 0 })).toBe(false);
  });

  test('nothing to lose is no refusal', () => {
    expect(unsavedWorkRefusal([])).toBeNull();
    expect(unsavedWorkRefusal([work('Clean', 0, 0)])).toBeNull();
  });

  test('the refusal names each session with work and what it would lose, and only those', () => {
    const refusal = unsavedWorkRefusal([work('Fix login', 2, 0), work('Clean', 0, 0), work('Add export', 1, 1)])!;
    expect(refusal.split('\n')).toEqual([
      'Not uninstalled: 2 sessions have work that is not pushed, and it would be lost.',
      '  "Fix login": 2 uncommitted files',
      '  "Add export": 1 uncommitted file, 1 commit not pushed',
      'Push it (or discard it in Kestrel), then run "kestrel node uninstall" again. Nothing was changed.',
    ]);
    expect(unsavedWorkRefusal([work('One', 0, 4)])).toContain('1 session has work');
  });
});

describe('what uninstall says', () => {
  test('leaving the account, or there being none', () => {
    expect(leftText('left')).toContain('Removed this node from your Kestrel Connect account');
    expect(leftText('not-signed-in')).toContain('not signed in');
  });

  test('asks with the word to type, and only that word agrees', () => {
    expect(confirmUninstallPrompt('this worker node')).toContain('Type "yes" to go on');
    expect(confirmDataPrompt('/home/user/.kestrel')).toContain('/home/user/.kestrel');
    expect(agreed('yes')).toBe(true);
    expect(agreed(' YES \n')).toBe(true);
    for (const answer of ['y', 'no', '', null]) expect(agreed(answer)).toBe(false);
  });

  test('the farewell names the keys to delete at the git host and the agents still signed in', () => {
    const lines = farewellLines({ sshPublicKeys: ['/home/user/.ssh/id_ed25519.pub'], agents: [{ label: 'Codex', where: '/home/user/.codex', signOut: 'codex logout' }], keptData: '/home/user/.kestrel' });
    expect(lines.join('\n')).toContain('Its data folder was kept: /home/user/.kestrel');
    expect(lines).toContain('  /home/user/.ssh/id_ed25519.pub');
    expect(lines.join('\n')).toContain('delete it there');
    expect(lines).toContain('  Codex (/home/user/.codex): codex logout');
  });

  test('with nothing left behind, it says only that it is done', () => {
    expect(farewellLines({ sshPublicKeys: [], agents: [], keptData: null })).toEqual(['Kestrel’s worker node is uninstalled.']);
  });
});
