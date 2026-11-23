import { ThinkingMark } from './ThinkingMark.tsx';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { sessionFolder } from '../sessionFolder.ts';
import { ChevronDown } from 'lucide-react';
import { CommandsPane } from './CommandsPane.tsx';
import { Changes } from './Changes.tsx';
import { SubAgentList, SubAgentView } from './SessionPane.tsx';
import { DetailsPanel } from './details/DetailsPanel.tsx';
import { detailsRefreshKey, useGitStatus, usePullRequests } from './details/sources.ts';
import { PullRequestView } from './PullRequestView.tsx';
import { NewPullRequestView } from './NewPullRequestView.tsx';
import { FileDocumentView } from './FileDocumentView.tsx';
import { useSessionDocuments, openPullRequest, reconcilePullRequests } from '../sessionView.ts';
import { takeAwaitingLookup } from '../newPullRequest.ts';
import { SessionDocumentTabs } from './SessionDocumentTabs.tsx';
import { lookupHost, primaryPullRequest } from '@kestrel/server/details';
import { hostTerms } from '@kestrel/server/host-terms';
import { uncommittedCount } from '@kestrel/server/commit-request';
import { SessionBar } from './SessionBar.tsx';
import { PaneArea } from './PaneArea.tsx';
import { simulator } from '../simulatorStore.ts';
import { browserPane, useBrowserTitle } from '../browserStore.ts';
import { serveRuns } from '../codeRun.ts';
import { usePanes } from '../paneState.ts';
import { serveChangesFocus } from '../changesFocus.ts';
import { CameFrom, Lineage } from './Lineage.tsx';
import type { SessionQueue, SessionSettings } from '@kestrel/server/model';
import type { Controls } from '@kestrel/server/tabs';
import { ComposerControls } from './ComposerControls.tsx';
import { Composer, type Inject } from './Conversation.tsx';
import { MessageList, type MessageListHandle } from './MessageList.tsx';
import { ComposerFoot } from './ComposerFoot.tsx';
import { act, actions, focusRequests, useApp, type AttachmentRefs } from '../store.ts';
import { presetForRole, ROLE_LABEL } from '@kestrel/server/who-does-what';
import { startRole } from '../review.ts';
import { useWhoDoesWhat } from '../whoDoesWhat.ts';
import { useTabs } from '../tabsStore.ts';
import { dayLabel } from '@kestrel/server/when';
import type { ForkContext } from './TurnFoot.tsx';
import { isOpenWork } from '@kestrel/server/workstreams';

const NO_QUEUE: SessionQueue = { items: [], held: false };

/** Within a few pixels of the end counts as the bottom. */
const isAtBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 48;

/** Where a session was left when the reader had scrolled up: restored when it comes back. A session
 *  left at the bottom has no entry and opens at the bottom, however much it has grown since. */
const scrollMemory = new Map<string, number>();

export function SessionWorkspace({ id }: { id: string }) {
  const session = useApp((s) => s.sessionsById.get(id));
  const stored = useApp((s) => s.details.get(id));
  const live = useApp((s) => s.live.get(id));
  const projects = useApp((s) => s.workspace?.projects) ?? [];
  const loaded = useApp((s) => s.workspace !== null);
  // Nothing is open beside the conversation until an icon is pressed; each session remembers the choice.
  const panes = usePanes(id);
  const open = panes.state.open;
  const browserTitle = useBrowserTitle(id);
  // The agent's browser calls go to this window; opening a page brings the Browser pane up.
  const showBrowser = useRef(() => {});
  showBrowser.current = () => panes.show('browser');
  useEffect(() => browserPane.serve(id, { reveal: () => showBrowser.current() }), [id]);
  // The agent's sim_ tools bring the Simulator pane up the same way.
  const showSimulator = useRef(() => {});
  showSimulator.current = () => panes.show('simulator');
  useEffect(() => simulator.serve(id, () => showSimulator.current()), [id]);
  // Running a code block from the conversation brings the Terminal pane up.
  const showTerminal = useRef(() => {});
  showTerminal.current = () => panes.show('terminal');
  useEffect(() => serveRuns(id, () => showTerminal.current()), [id]);
  // An edit line in the conversation brings the Changes pane up at that file (changesFocus.ts).
  const showChanges = useRef(() => {});
  showChanges.current = () => panes.show('changes');
  useEffect(() => serveChangesFocus(id, () => showChanges.current()), [id]);
  // Tags are edited in Details: "Tag…" from a menu opens it, and its tag box.
  const taggingHere = useApp((s) => s.tagging === id);
  const showDetails = useRef(() => {});
  showDetails.current = () => panes.show('context');
  useEffect(() => {
    if (taggingHere) showDetails.current();
  }, [taggingHere]);
  const hasColumns = Object.values(open).some(Boolean);
  const [inject, setInject] = useState<Inject | null>(null);
  // Messages are memoized, so they get callbacks that never change and call the latest handlers.
  const handlers = useRef({ choose: (_: string) => {}, reply: (_: string) => {}, reuse: (_: string) => {} });
  const [stable] = useState(() => ({ choose: (text: string) => handlers.current.choose(text), reply: (text: string) => handlers.current.reply(text), reuse: (text: string) => handlers.current.reuse(text) }));

  // `session` changes identity whenever the server reports a change to it, which also drops the cached detail.
  useEffect(() => {
    if (session) actions.loadDetail(id);
  }, [id, session, stored]);
  // Streaming output for this session only, on its own channel.
  useEffect(() => actions.watch(id), [id]);
  // The live channel is newer than the fetched detail wherever it has something to say.
  // The cached detail is dropped and refetched whenever the session changes. Keep showing the last
  // one meanwhile: swapping the conversation for a "Loading…" line collapses it and loses the scroll position.
  const lastStored = useRef(stored);
  if (stored) lastStored.current = stored;
  const shown = stored ?? lastStored.current;
  const detail = useMemo(() => (shown && live ? { ...shown, messages: live.messages, files: live.files, agentOutput: live.agentOutput, kestrelTools: live.kestrelTools, kestrelMissing: live.kestrelMissing } : shown), [shown, live]);
  // The Details sources are asked again whenever the session or its changes do; the git one feeds the top line too.
  const refreshKey = detailsRefreshKey(session?.updatedAt ?? 0, detail?.files ?? []);
  const git = useGitStatus(id, refreshKey);
  const documents = useSessionDocuments(id);
  const activeDocument = documents.tabs.find(t => t.id === documents.activeId)!;
  const pullRequests = usePullRequests(id);
  // Any document other than Conversation parks the conversation (kept on the page, scroll and all).
  const docOpen = activeDocument.kind !== 'conversation';
  useEffect(() => {
    if (pullRequests.value.state !== 'ready') return;
    reconcilePullRequests(id, pullRequests.value.value.pullRequests);
    // A pull request just created whose address had no number: open it now that the lookup has it.
    const created = takeAwaitingLookup(id) ? primaryPullRequest(pullRequests.value.value.pullRequests) : undefined;
    if (created) openPullRequest(id, created);
  }, [id, pullRequests.value]);
  // The repository's host decides the words: pull request or merge request.
  const terms = hostTerms(lookupHost(pullRequests.value));
  const bodyRef = useRef<HTMLDivElement>(null);
  // Held in state, not a ref: the conversation is not on the page until the session has loaded,
  // and the effect that watches its height has to run again when it appears.
  const [inner, setInner] = useState<HTMLDivElement | null>(null);
  // The message box floats over the foot of the conversation, so the conversation (and its scroll
  // bar) runs the full height. Its measured height is the room left under the last message.
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(140);
  useEffect(() => {
    if (!dock) return;
    const observer = new ResizeObserver(() => setComposerHeight(Math.round(dock.getBoundingClientRect().height)));
    observer.observe(dock);
    return () => observer.disconnect();
  }, [dock]);
  // The session whose place was last restored: the tab can show another session without remounting.
  const restored = useRef<string | null>(null);
  // The list draws only the rows near the screen, so a jump to a row goes through it, by index.
  const list = useRef<MessageListHandle>(null);
  // Whether the view follows new output. True while the reader is at the bottom; scrolling up
  // lets go, and coming back to the bottom (or sending a message) takes hold again.
  const follow = useRef(true);
  const [isFollowing] = useState(() => () => follow.current);
  // The last scroll position seen, to tell the reader scrolling up from the page growing under them.
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const [pending, setPending] = useState<Partial<SessionSettings>>({});
  const count = detail?.messages.length ?? 0;
  const toBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    follow.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };
  // Come back to where this session was left the first time there is something to show.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || count === 0 || restored.current === id) return;
    restored.current = id;
    // The list starts where the session was left, or at the end (MessageList's `initialTop`).
    // Opened from the Needs you queue: land on the card that is waiting. The list moves there
    // itself: only the rows near the screen are drawn, and they are measured as they come.
    const card = focusRequests.delete(id) && (list.current?.scrollToPendingCard() ?? false);
    const top = scrollMemory.get(id);
    // On the way to the end every step is downwards, so none of them reads as the reader scrolling up.
    lastTop.current = top ?? 0;
    follow.current = !card && top === undefined;
    setAway(!follow.current);
  }, [count, id]);
  // Anything that makes the conversation taller (a message, streamed text, a tool step, the
  // status line) keeps the bottom in view, unless the reader has scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    // Border box, so the room left under the last message (padding) counts as growth too.
    observer.observe(inner, { box: 'border-box' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [inner]);

  // What every turn foot's Fork needs of the session (each foot makes the menu's own item, `forkItem`,
  // for its turn). Kept while it says the same, so no row is drawn again as text streams.
  // Before the return below: a session just created is not in the workspace on its first render,
  // and every hook must still run then.
  const forkAgent = session?.agent;
  const forkBusy = session ? isOpenWork(session) : false;
  const fork = useMemo<ForkContext | undefined>(() => (forkAgent ? { sessionId: id, agent: forkAgent, busy: forkBusy } : undefined), [id, forkAgent, forkBusy]);

  // The roles the user gave an agent (Settings → Models & roles → Who does what): what is typed can be sent
  // to one of them instead, to be done in this session's worktree (server: delegation.ts `startRole`).
  const who = useWhoDoesWhat();
  const worktree = Boolean(session?.worktreePath) && !session?.worktreeDiscarded;
  const sendTo = useMemo(() => {
    const options = (['design', 'build'] as const).flatMap((role) => {
      const preset = presetForRole(who, role);
      return preset && worktree ? [{ id: role, label: `Send to ${ROLE_LABEL[role]}`, hint: preset.name }] : [];
    });
    const sendRole = async (role: string, text: string) => (await act(() => startRole(id, role as 'design' | 'build', text).then(() => true))) === true;
    return { options, send: sendRole };
  }, [who, id, worktree]);
  if (!session) return <section className="session-workspace"><div className="empty-list pad">{loaded ? 'This session no longer exists.' : 'Loading…'}</div></section>;

  const settings = live?.settings ?? detail?.settings;
  const current: Controls = { agent: session.agent, model: pending.model ?? settings?.model ?? '', effort: pending.effort ?? settings?.effort ?? '', fast: pending.fast ?? settings?.fast ?? false, permission: pending.permission ?? settings?.permission ?? (session.startedIn ? 'ask' : 'readonly'), projectId: session.startedIn, groupId: session.groupId };
  const changed = settingsChanged(pending, settings);
  const projectIsPlain = sessionFolder(session, projects.find((p) => p.id === session.startedIn))?.isGit === false;
  const agentCard = <SubAgentList agents={live?.subagents ?? []} openId={open.agent ? panes.state.agentId : null} onOpen={panes.toggleAgent} />;
  // The index of the message the card sits under; -1 puts it at the end.
  const anchorAt = live?.subagentsAfter ? (detail?.messages.findIndex((m) => m.id === live.subagentsAfter) ?? -1) : -1;
  const choose = (choice: string) => setInject({ id, text: `${choice}.`, n: Date.now() });
  const stepRunning = detail?.messages.at(-1)?.activity?.some((a) => a.status === 'running') ?? false;
  // A running step already says what is happening on its own line, so the turn's line stays general then.
  // It is always there while the turn runs: taking it away during steps made the text below jump.
  const workingText = stepRunning ? 'Working…' : live?.status || 'Working…';
  const waiting = session.state === 'attention' && (detail?.messages.some((m) => m.input && !m.input.resolved) ?? false);
  const send = async (text: string, files: AttachmentRefs | null = null) => {
    toBottom(); // sending a message always returns to the latest
    const sent = await actions.reply(id, text, pending, files);
    if (sent) setPending({});
    // Again once the message itself is on the page, in case it arrived after the first jump.
    requestAnimationFrame(toBottom);
    return sent;
  };
  // A reply picked in the conversation goes now; while the agent is busy it waits in the composer instead.
  const reply = (text: string) => {
    if (session.state === 'running' || waiting) setInject({ id, text, n: Date.now() });
    else void send(text);
  };
  // A sent message put back in the message box to edit: never sent from here.
  const reuse = (text: string) => setInject({ id, text, n: Date.now() });
  handlers.current = { choose, reply, reuse };
  const editQueued = (text: string) => setInject({ id, text, n: Date.now(), append: true });

  return (
    <section className={`session-workspace${hasColumns ? '' : ' focus-conversation'}`} data-session-id={id}>
      <SessionBar session={session} detail={detail} panes={panes} browserTitle={browserTitle} git={git.value} pullRequests={pullRequests} onOpenPullRequest={(request) => openPullRequest(id, request)} />
      <PaneArea
        scopeKey={id}
        state={panes.state}
        mainLabel="Session content"
        contextLabel="Details"
        onClosePane={panes.hide}
        changes={detail && <Changes detail={detail} files={detail.files} problem={live?.filesProblem ?? null} plainFolder={projectIsPlain} git={git.value} />}
        context={detail && <DetailsPanel detail={detail} controls={current} pending={changed} git={git.value} refreshKey={refreshKey} onOpenChanges={() => panes.show('changes')} />}
        agent={<SubAgentView agent={live?.subagents.find((a) => a.id === panes.state.agentId)} onClose={panes.closeAgent} />}
        commands={(visible) => <CommandsPane sessionId={id} selectedId={panes.state.commandId} onSelect={panes.showCommand} visible={visible} />}
        main={
        <div className="session-content">
          <SessionDocumentTabs sessionId={id} documents={documents} terms={terms} />
          <div className="session-view-body">
          {docOpen && (
            <div id={`${id}-${activeDocument.id}-panel`} className="pr-panel" role="tabpanel" aria-labelledby={`${id}-${activeDocument.id}-tab`}>
              {activeDocument.kind === 'pull-request' && <PullRequestView source={pullRequests} number={activeDocument.number} />}
              {activeDocument.kind === 'file' && <FileDocumentView key={activeDocument.id} sessionId={id} path={activeDocument.path} />}
              {activeDocument.kind === 'new-pull-request' && (
                <NewPullRequestView sessionId={id} doc={activeDocument} terms={terms} branch={session.branch ?? ''} uncommitted={uncommittedCount(git.value) > 0} onCreated={pullRequests.refresh} />
              )}
            </div>
          )}
        <div className="conversation" id={`${id}-conversation-panel`} role="tabpanel" tabIndex={-1} aria-label="Conversation" data-parked={docOpen} inert={docOpen}>
          <div
            className="conversation-body"
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              // Only the reader moving up lets go of the bottom. A scroll event that arrives after the
              // page grew (a picture loaded, the message box was measured) finds the view short of the
              // new end without anyone having scrolled; the height observer brings it back down.
              if (isAtBottom(el)) follow.current = true;
              else if (el.scrollTop < lastTop.current - 1) follow.current = false;
              lastTop.current = el.scrollTop;
              if (follow.current) scrollMemory.delete(id);
              else scrollMemory.set(id, el.scrollTop);
              setAway(!follow.current);
            }}
          >
           <div className="conversation-inner" ref={setInner} style={{ paddingBottom: composerHeight + 96 }}>
            {!detail ? (
              <div className="muted">Loading conversation…</div>
            ) : detail.messages.length === 0 ? (
              <div className="muted">No messages yet.</div>
            ) : (
              <>
                {/* The sub-agent card is part of the conversation: it sits under the message it belongs to. */}
                <MessageList
                  key={id}
                  ref={list}
                  scrollRef={bodyRef}
                  isFollowing={isFollowing}
                  initialTop={scrollMemory.get(id)}
                  head={<ConversationHead sessionId={id} at={detail.messages[0]?.at ?? session.createdAt} />}
                  messages={detail.messages}
                  sessionId={id}
                  onChoice={stable.choose}
                  onReply={stable.reply}
                  onReuse={stable.reuse}
                  anchorAt={anchorAt}
                  anchored={agentCard}
                  working={session.state === 'running'}
                  workingText={workingText}
                  fork={fork}
                />
                <Lineage sessionId={id} messages={detail.messages} />
                {anchorAt === -1 && agentCard}
              </>
            )}
           </div>
          </div>
          {/* Sits just above the message box, whatever height the box is. */}
          <div className="to-bottom-anchor" style={{ bottom: composerHeight }}>
            {away && (
              // Scrolled up: the bird says the agent is still working below; once it has finished, a chevron. Either goes to the bottom.
              <button className={`to-bottom${session.state === 'running' ? ' working' : ''}`} aria-label={session.state === 'running' ? 'The agent is working below. Go to the latest' : 'Go to the latest'} onClick={toBottom}>
                {session.state === 'running' ? <ThinkingMark status={workingText} /> : <ChevronDown aria-hidden />}
              </button>
            )}
          </div>
          <div className="composer-dock" ref={setDock}>
          <Composer
            sendTo={sendTo}
            key={id}
            draftKey={id}
            running={session.state === 'running'}
            waiting={waiting}
            interrupted={session.state === 'interrupted'}
            // The live list once the agent has given one; until then what was stored with the session.
            slashCommands={live?.slashCommands.length ? live.slashCommands : detail?.slashCommands}
            inject={inject}
            onStop={() => void actions.stop(id)}
            onSend={send}
            above={<ComposerFoot sessionId={id} messages={detail?.messages} queue={live?.queue ?? detail?.queue ?? NO_QUEUE} running={session.state === 'running'} waiting={waiting} onEdit={editQueued} onOpenCommand={panes.showCommand} />}
            controls={
              <>
                <ComposerControls value={current} mode="running" sessionId={id} onChange={(c) => setPending({ model: c.model, effort: c.effort ?? '', fast: c.fast ?? false, permission: c.permission })} />
                {changed && <span className="ctl-note">Applies from your next message</span>}
              </>
            }
          />
          </div>
        </div>
          </div>
        </div>
        }
      />
    </section>
  );
}

/** Before the first message: the day the conversation started (the first message's own time when it has one, else when the session was made), and where it came from. */
const ConversationHead = memo(function ConversationHead({ sessionId, at }: { sessionId: string; at: number }) {
  return (
    <>
      <div className="day-divider" title={new Date(at).toLocaleString()}>
        {dayLabel(at, Date.now()).toUpperCase()}
      </div>
      <CameFrom sessionId={sessionId} />
    </>
  );
});

/** A model, effort, fast-mode or mode change waiting for the next message. */
function settingsChanged(pending: Partial<SessionSettings>, settings: SessionSettings | undefined): boolean {
  return (
    (pending.model !== undefined && pending.model !== (settings?.model ?? '')) ||
    (pending.effort !== undefined && pending.effort !== (settings?.effort ?? '')) ||
    (pending.fast !== undefined && pending.fast !== (settings?.fast ?? false)) ||
    (pending.permission !== undefined && pending.permission !== settings?.permission)
  );
}
