// Settings → Permissions: "Always allowed outside the sandbox" (server: sandbox-allow/, the shapes in
// @kestrel/server/sandbox-allow). The list is held once in the app store through useResource; an
// add or a removal writes back what the server stored. The server checks every entry and says why
// it refuses one; nothing is checked only here.
import { SettingSection } from './SettingHelp.tsx';
import { useState } from 'react';
import { describeEntry, entryId, type FolderAccess, type InactiveEntry, type SandboxAllowView } from '@kestrel/server/sandbox-allow';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { act, call, OLDER_SERVER, putResource, RESTART_REASON } from '../store.ts';

export const SANDBOX_ALLOW_PATH = '/api/sandbox-allow';
const asView = (raw: unknown): Sourced<SandboxAllowView> => ready(raw as SandboxAllowView);

type Kind = 'command' | 'folder';

async function change(init: RequestInit): Promise<boolean> {
  const view = await act(() => call<SandboxAllowView>(SANDBOX_ALLOW_PATH, init));
  if (view) putResource(SANDBOX_ALLOW_PATH, ready(view));
  return view !== undefined;
}

/** Under the card's choices: what an "Always allow" choice does, and where the list is kept. */
export function SandboxOfferNote() {
  return <p className="sandbox-offer-note">An "Always allow" choice adds exactly what it names to the always-allowed list (Settings → Permissions), for every project, and allows this command now.</p>;
}

function AddEntry() {
  const [kind, setKind] = useState<Kind>('command');
  const [text, setText] = useState('');
  const [access, setAccess] = useState<FolderAccess>('read-write');
  const add = async () => {
    const body = kind === 'command' ? { kind, command: text } : { kind, path: text, access };
    if (await change({ method: 'POST', body: JSON.stringify(body) })) setText('');
  };
  return (
    <div className="sandbox-allow-add">
      <select aria-label="Kind of entry" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
        <option value="command">Command</option>
        <option value="folder">Folder</option>
      </select>
      <input aria-label={kind === 'command' ? 'Command' : 'Folder'} placeholder={kind === 'command' ? 'git commit' : '~/.gnupg'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && void add()} />
      {kind === 'folder' && (
        <select aria-label="Access" value={access} onChange={(e) => setAccess(e.target.value as FolderAccess)}>
          <option value="read-write">Read and write</option>
          <option value="read">Read only</option>
        </select>
      )}
      <button type="button" disabled={!text.trim()} onClick={() => void add()}>
        Add
      </button>
    </div>
  );
}

const removeEntry = (id: string) => void change({ method: 'DELETE', body: JSON.stringify({ id }) });

/** Entries stored before a rule changed that the rules now refuse: shown with why, never applied. */
function InactiveEntries({ inactive }: { inactive: readonly InactiveEntry[] }) {
  return (
    <>
      <p className="settings-help">Not applied: these were added before Kestrel refused entries like them. They have no effect; remove them, and add what the reason names instead.</p>
      <ul className="tag-rules sandbox-allow-list sandbox-allow-inactive">
        {inactive.map(({ entry, reason }) => (
          <li key={entryId(entry)}>
            <span className="sandbox-allow-entry">
              <span>
                <span className="sandbox-allow-kind">Not applied</span>
                <code>{describeEntry(entry)}</code>
              </span>
              <span className="sandbox-allow-reason">{reason}</span>
            </span>
            <button type="button" className="sandbox-allow-remove" onClick={() => removeEntry(entryId(entry))}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function SandboxAllowSettingControls() {
  const loaded = useResource(SANDBOX_ALLOW_PATH, asView).value;
  if (loaded.state !== 'ready') return <p className="settings-help">{loaded.state === 'loading' ? 'Loading…' : loaded.reason === RESTART_REASON ? OLDER_SERVER : loaded.reason}</p>;
  const { entries, inactive = [] } = loaded.value;
  return (
    <>
      {entries.length > 0 ? (
        <ul className="tag-rules sandbox-allow-list">
          {entries.map((entry) => (
            <li key={entryId(entry)}>
              <span>
                <span className="sandbox-allow-kind">{entry.kind === 'command' ? 'Command' : 'Folder'}</span>
                <code>{describeEntry(entry)}</code>
              </span>
              <button type="button" className="sandbox-allow-remove" onClick={() => removeEntry(entryId(entry))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-help">Nothing yet. Add an entry here, or choose "Always allow this command" or "Always allow this folder" on a card that asks to run a command outside the sandbox.</p>
      )}
      {inactive.length > 0 && <InactiveEntries inactive={inactive} />}
      <AddEntry />
    </>
  );
}

const HELP = (
  <>
    <p className="settings-help">
      Commands and folders that are always in bounds for a session's shell commands, in every project. A folder is added to what sandboxed commands may read (read only) or also write (read and write), so they simply work. A command is a program and its
      subcommand, such as <code>git commit</code> or <code>gpg</code>: when the agent asks to run it outside the sandbox, it runs without a card, as long as the whole command line is that command (no other commands chained to it, nothing the shell
      would expand, no path outside the session's folders). Anything else still asks. A command put inside a known wrapper (such as <code>rtk git commit</code>, which a hook on this computer may make of <code>git commit</code>) is judged as the command inside it; a wrapper itself cannot be an entry.
    </p>
    <p className="settings-help">
      Claude: applies to sessions started by another session (handoff, delegate, spawn), the ones whose commands run in a sandbox; a folder change takes effect from the session's next message. Codex: every session is sandboxed; read-and-write folders are
      writable in each turn, and in Auto a listed command or a request for more access to listed folders is accepted without a card. In Manual and Accept edits Codex still asks about every command.
    </p>
  </>
);

export function SandboxAllowSetting() {
  return (
    <SettingSection title="Always allowed outside the sandbox" help={HELP}>
      <SandboxAllowSettingControls />
    </SettingSection>
  );
}
