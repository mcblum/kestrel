// The scripted agent's "/sandbox" message (scripted.ts, dev only): a card like a Claude child's for
// a command outside the sandbox, offering both "Always allow" choices, so the card and Settings →
// Workflow can be tried by hand. The folder it offers is a throwaway one under the temp folder.
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offerOptions } from '../sandbox-allow/offer.ts';
import type { SandboxOffer } from '../shared/sandbox-allow.ts';
import type { InputRequest } from './types.ts';

const COMMAND = 'git commit -S -m "Add the release notes"';

export function scriptedSandboxCard(id: string): InputRequest {
  const folder = join(realpathSync(tmpdir()), 'kestrel-scripted-gnupg');
  mkdirSync(folder, { recursive: true });
  const offer: SandboxOffer = { command: ['git', 'commit'], folder: { path: folder, access: 'read-write' } };
  return {
    id,
    kind: 'approval',
    tool: 'Bash',
    title: 'Run git commit (outside the sandbox)',
    detail: `Runs outside the sandbox: it can change files outside this session's folder.\n\n${COMMAND}`,
    options: [{ id: 'allow', label: 'Allow', role: 'allow' }, ...offerOptions(offer), { id: 'allow-outside', label: 'Allow all outside the sandbox', role: 'allow' }, { id: 'deny', label: 'Deny', role: 'deny' }],
    sandboxOffer: offer,
  };
}
