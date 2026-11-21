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
  // Files attached before the session exists are held as a draft and go with the first message.
  const files = useAttachments(`tab:${tab.id}`, busy);
  // A checkout off its default branch asks where the session starts, before it exists.
  const startBase = useStartBase();
  useEffect(() => input.current?.focus(), [tab.id]);

  const update = (value: string) => {
    setText(value);
    drafts.set(`tab:${tab.id}`, value);
  };
  const slashPath = `/api/agents/${controls.agent}/slash-commands?projectId=${encodeURIComponent(controls.projectId ?? '')}&folderId=${encodeURIComponent(chosen.folder?.id ?? '')}`;
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
    const where = await startBase.ask(controls.projectId, chosen.folder?.id ?? null);
    if (!where) {
      setBusy(false);
      return input.current?.focus();
    }
    const permission = controls.permission;
    const created = await actions.createSession({ prompt, agent: controls.agent, projectId: controls.projectId, groupId, ...(chosen.folder ? { folderId: chosen.folder.id } : {}), model: controls.model || undefined, ...(controls.modelChosen ? { modelChosen: true } : {}), ...(controls.effort ? { effort: controls.effort } : {}), ...(controls.fast !== undefined ? { fast: controls.fast } : {}), permission, ...where, ...refs });
    setBusy(false);
    if (!created) return;
    update('');
    files.sent();
    // Opened from PINNED: pinned the moment it exists. Not one of the choices new sessions remember.
    const { pinned, modelChosen: _chosen, ...sent } = controls;
    if (pinned) void actions.setPinned('session', created.id, true);
    tabActions.becomeSession(tab.id, created.id, { ...sent, permission });
  };

  const hasProject = controls.projectId !== null;
  return (
    <section className="new-session" aria-label="New session">
      <div className="new-session-space">
        <h1>What are we working on?</h1>
        {controls.pinned && <p className="new-session-note muted">This session will be pinned.</p>}
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
              {groups.length > 0 && (
                <span className="ctl" title="Add to a group">
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
            {!hasProject && <span className="ctl-note">No project: works in a scratch folder</span>}
        </div>
        {files.dropZone}
      </div>
      {startBase.dialog}
    </section>
  );
}
