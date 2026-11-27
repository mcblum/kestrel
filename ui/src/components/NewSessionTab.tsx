// A tab that is not a session yet. Nothing exists on the server until Start session; then this
// tab becomes that session in place. The message box sits at the bottom, where it stays once
// the session is running, with the same row of controls.
import { useChosenFolder } from './FolderPicker.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { fitsGroup } from '@kestrel/server/project-groups';
import type { Controls, Tab } from '@kestrel/server/tabs';
import { actions, drafts, useApp } from '../store.ts';
import { tabActions } from '../tabsStore.ts';
import { ComposerControls } from './ComposerControls.tsx';
import { useStartBase } from './StartBaseDialog.tsx';
import { useAttachments } from './attachments/useAttachments.tsx';
import { MessageInput, type MessageInputHandle } from './MessageInput.tsx';
import { useSlashMenu } from './useSlashMenu.tsx';
import { useResource } from '../data/resources.ts';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { remoteMode, startingOn } from '@kestrel/server/start-computer';
import { useOtherComputers } from '../startComputers.ts';
import type { SlashCommand } from '@kestrel/server/slash-commands';

/** What "/" offers for the agent and project chosen in the box: asked of the agent without starting anything. */
const asCommands = (raw: unknown): Sourced<SlashCommand[]> => {
  const commands = (raw as { commands?: unknown })?.commands;
  return ready(Array.isArray(commands) ? (commands as SlashCommand[]) : []);
};
/** A list that came back is kept; an empty one (the agent could not say yet) is asked for again. */
const hasCommands = (commands: SlashCommand[]) => commands.length > 0;

export function NewSessionTab({ tab }: { tab: Extract<Tab, { kind: 'new' }> }) {
  const controls = tab.controls;
  const chosen = useChosenFolder(controls);
  const allGroups = useApp((s) => s.workspace?.groups) ?? [];
  // Only groups the new session may join: a project's group takes only that project's sessions.
  const groups = allGroups.filter((g) => fitsGroup(g, { startedIn: controls.projectId, landedIn: null }));
  // A group picked before the project changed no longer fits: the session starts in no group.
  const groupId = groups.some((g) => g.id === controls.groupId) ? controls.groupId : null;
  const onChange = useCallback((next: Controls) => tabActions.setControls(tab.id, next), [tab.id]);
  const [text, setText] = useState(() => drafts.get(`tab:${tab.id}`));
  const [busy, setBusy] = useState(false);
  const input = useRef<MessageInputHandle>(null);
  // One id per start on another computer, kept across a second Enter after it did not answer in time, so that
  // computer starts it once (item 81). A new one only once a start went through.
  const startId = useRef<string>(crypto.randomUUID());
  // Files attached before the session exists are held as a draft and go with the first message.
  const files = useAttachments(`tab:${tab.id}`, busy);
  // A checkout off its default branch asks where the session starts, before it exists.
  const startBase = useStartBase();
  useEffect(() => input.current?.focus(), [tab.id]);

  const update = (value: string) => {
    setText(value);
    drafts.set(`tab:${tab.id}`, value);
  };
  // Another computer of the account chosen in the pill (issue 52): sent there, with Manual or Auto only.
  const others = useOtherComputers();
  const machine = controls.machine && others?.some((m) => m.id === controls.machine) ? controls.machine : null;
  const machineName = machine ? others!.find((m) => m.id === machine)!.name : null;
  const sentMode = machineName ? remoteMode(controls.permission, machineName) : null;
  // What "/" offers is asked of this computer's agent; another computer's is not asked from here.
  const slashPath = machine ? null : `/api/agents/${controls.agent}/slash-commands?projectId=${encodeURIComponent(controls.projectId ?? '')}&folderId=${encodeURIComponent(chosen.folder?.id ?? '')}`;
  const offered = useResource(slashPath, asCommands, '', hasCommands).value;
  const slash = useSlashMenu(text, offered.state === 'ready' ? offered.value : undefined, busy, (next) => {
    update(next);
    input.current?.focus();
  });
  const start = async () => {
    const prompt = text.trim();
    const refs = files.refs();
    if ((!prompt && !refs) || busy || files.blocked) return;
    setBusy(true);
    if (machine && sentMode) return startThere(machine, prompt, refs, sentMode.mode);
    const where = await startBase.ask(controls.projectId, chosen.folder?.id ?? null);
    if (!where) {
      setBusy(false);
      return input.current?.focus();
    }
    const permission = controls.permission;
    const created = await actions.createSession({ prompt, agent: controls.agent, projectId: controls.projectId, groupId, ...(chosen.folder ? { folderId: chosen.folder.id } : {}), model: controls.model || undefined, ...(controls.modelChosen ? { modelChosen: true } : {}), ...(controls.effort ? { effort: controls.effort } : {}), ...(controls.fast !== undefined ? { fast: controls.fast } : {}), ...(controls.purpose && controls.projectId === null ? { purpose: controls.purpose } : {}), permission, ...where, ...refs });
    setBusy(false);
    if (!created) return;
    update('');
    files.sent();
    // Opened from PINNED: pinned the moment it exists. Not one of the choices new sessions remember.
    const { pinned, modelChosen: _chosen, purpose: _purpose, ...sent } = controls;
    if (pinned) void actions.setPinned('session', created.id, true, true);
    tabActions.becomeSession(tab.id, created.id, { ...sent, permission });
  };

  /** Started on another computer: its page opens here at once from the answer, the tab kept while its row arrives. */
  const startThere = async (id: string, prompt: string, refs: ReturnType<typeof files.refs>, mode: 'ask' | 'auto') => {
    const created = await actions.createSession({ machine: id, prompt, agent: controls.agent, projectId: controls.projectId, groupId: null, model: controls.model, permission: mode, startId: startId.current, ...refs });
    setBusy(false);
    if (!created) return input.current?.focus();
    startId.current = crypto.randomUUID();
    update('');
    files.sent();
    if (controls.pinned) void actions.setPinned('session', created.id, true, true);
    tabActions.becomeSession(tab.id, created.id, null);
  };

  const hasProject = controls.projectId !== null;
  return (
    <section className="new-session" aria-label="New session">
      <div className="new-session-space">
        <h1>What are we working on?</h1>
        {controls.pinned && <p className="new-session-note muted">This session will be pinned.</p>}
        {busy && machineName && <p className="new-session-note muted" role="status">{startingOn(machineName)}</p>}
        {controls.purpose && controls.projectId === null && <p className="new-session-note muted">From Set up this computer: it may offer to run a step, and you answer each on a card.</p>}
      </div>
      <div className="composer-wrap" ref={files.anchor}>
        <div className={`composer-box${files.hasFiles ? ' has-attachments' : ''}`}>
          {slash.menu}
          {files.tiles}
          <MessageInput
            ref={input}
            onPaste={files.onPaste}
            label="Describe your task"
            placeholder="Describe your task…"
            value={text}
            onChange={(value) => {
              update(value);
              slash.onText();
            }}
            onKeyDown={(e) => {
              if (!e.nativeEvent.isComposing && slash.onKey(e)) return void e.preventDefault();
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void start();
              }
            }}
          />
          <div className="composer-actions">
            {files.button}
            <button className="send-icon" aria-label={busy ? 'Starting…' : 'Start the session (Enter). Shift Enter adds a new line'} title={files.blocked ?? undefined} disabled={(!text.trim() && !files.hasFiles) || busy || files.blocked !== null} onClick={() => void start()}>
              <CornerDownLeft aria-hidden />
            </button>
          </div>
        </div>
        <div className="composer-under">
              <ComposerControls value={controls} mode="new" onChange={onChange} />
              {!machine && groups.length > 0 && (
                <span className="ctl ctl-group" title={`Group: ${groups.find((g) => g.id === groupId)?.name ?? 'none'}. Add the session to a group`}>
                  <select aria-label="Group" value={groupId ?? ''} onChange={(e) => onChange({ ...controls, groupId: e.target.value || null })}>
                    <option value="">No group</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </span>
              )}
        </div>
        {files.dropZone}
      </div>
      {startBase.dialog}
    </section>
  );
}
