import { useWorkingTree } from '../workingTree.ts';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { sessionFolder } from '../sessionFolder.ts';
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
import { AsidePane } from './AsidePane.tsx';
import { AsideContext, type AsideHost } from '../asides.ts';
import { simulator } from '../simulatorStore.ts';
import { browserPane, useBrowserTitle } from '../browserStore.ts';
import { serveRuns } from '../codeRun.ts';
import { usePanes } from '../paneState.ts';
import { serveChangesFocus } from '../changesFocus.ts';
import { CameFrom, Lineage } from './Lineage.tsx';
import type { SessionQueue, SessionSettings } from '@kestrel/server/model';
import type { Controls } from '@kestrel/server/tabs';
import { ComposerControls } from './ComposerControls.tsx';
import { Composer, waitsOnCard, type Inject } from './Conversation.tsx';
import { MessageList, type MessageListHandle } from './MessageList.tsx';
import { useFollowEnd } from '../conversationFollow.ts';
import { ToBottom } from './ToBottom.tsx';
import { ComposerFoot } from './ComposerFoot.tsx';
import { act, actions, focusRequests, mergeMessages, messageFocus, useApp, type AttachmentRefs } from '../store.ts';
import { notAnsweredText } from '@kestrel/server/machines';
import { useMachineName } from '../machines.ts';
import { useBehindRetry } from '../behindRetry.ts';
import { FilesElsewhere } from './HeldElsewhere.tsx';
import '../styles/machines.css';
import { presetForRole, ROLE_LABEL } from '@kestrel/server/who-does-what';
import { startRole } from '../review.ts';
import { useWhoDoesWhat } from '../whoDoesWhat.ts';
import { useTabs } from '../tabsStore.ts';
import { dayLabel } from '@kestrel/server/when';
import type { ForkContext } from './TurnFoot.tsx';
import { isOpenWork } from '@kestrel/server/workstreams';

const NO_QUEUE: SessionQueue = { items: [], held: false };


/** What the hooks read before the session is in the workspace: no worktree. */
const NO_TREE = { id: '', title: '', worktreePath: null, branch: null, worktreeDiscarded: false };

/**
 * A session's page, the same whether it runs here or on another computer of the account (account-sessions.md, "A
 * session on another computer drawn as one here, as built"). For one there (`runsOn`) the few differences are small:
 * the bar says where it runs; its conversation is the account's copy with what streams from that computer laid over
 * it, and a line with Try again when that computer was asked for what the copy lacks and did not answer; its
 * terminal, browser and simulator stay on that computer and say so; a file not held here says where it is
 * (`FilesElsewhere`). Everything else is read and done through the same routes, which the server carries out there
 * (remote-actions.ts).
 */
export function SessionWorkspace({ id }: { id: string }) {
  const session = useApp((s) => s.sessionsById.get(id));
  // The computer it runs on, for a session there; null for this computer's own.
  const machine = useMachineName(session?.runsOn);
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
  // A session on another computer: its agent's browser, simulator and code-block runs are that computer's window's.
  useEffect(() => (machine ? undefined : browserPane.serve(id, { reveal: () => showBrowser.current() })), [id, machine]);
  // The agent's sim_ tools bring the Simulator pane up the same way.
  const showSimulator = useRef(() => {});
  showSimulator.current = () => panes.show('simulator');
  useEffect(() => (machine ? undefined : simulator.serve(id, () => showSimulator.current())), [id, machine]);
  // Running a code block from the conversation brings the Terminal pane up.
  const showTerminal = useRef(() => {});
  showTerminal.current = () => panes.show('terminal');
  useEffect(() => (machine ? undefined : serveRuns(id, () => showTerminal.current())), [id, machine]);
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
  // For a session on another computer, what streamed from it replaces the same message of the account's copy, or follows it.
  const elsewhere = machine !== null;
  const detail = useMemo(() => (shown && live ? { ...shown, messages: elsewhere ? (live.messages.length ? mergeMessages(shown.messages, live.messages) : shown.messages) : live.messages, files: live.files, agentOutput: live.agentOutput, kestrelTools: live.kestrelTools, kestrelMissing: live.kestrelMissing, ...(live.mcpServers.length ? { mcpServers: live.mcpServers } : {}) } : shown), [shown, live, elsewhere]);
  // The account's copy is behind its head: read it again a few times; Try again asks its computer afresh.
  const behind = detail?.remote?.current === false;
  const tryAgain = useBehindRetry(id, behind);
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
  // The list draws only the rows near the screen, so a jump to a row goes through it, by index.
  const list = useRef<MessageListHandle>(null);
  const [pending, setPending] = useState<Partial<SessionSettings>>({});
  const count = detail?.messages.length ?? 0;
  // Opened from the Needs you queue: land on the card that is waiting. The list moves there itself: only the rows
  // near the screen are drawn, and they are measured as they come. Opened from a link to the review: land on the
  // reviewer's message the findings came from.
  const { bodyRef, setInner, setDock, composerHeight, isFollowing, away, toBottom, onScroll, initialTop } = useFollowEnd(id, count, () => {
    const at = messageFocus.get(id);
    messageFocus.delete(id);
    return (at !== undefined && (list.current?.scrollToMessage(at) ?? false)) || (focusRequests.delete(id) && (list.current?.scrollToPendingCard() ?? false));
  });

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
  // The branch a pull request is made from: a guest's is its host's (@kestrel/server/working-tree).
  const workingTree = useWorkingTree(session ?? NO_TREE).tree;
  const requestBranch = workingTree?.branch ?? '';
  // A session there has its worktree on that computer: its branch is what is known of it here.
  const worktree = elsewhere ? workingTree !== null : Boolean(session?.worktreePath) && !session?.worktreeDiscarded;
  const sendTo = useMemo(() => {
    const options = (['design', 'build'] as const).flatMap((role) => {
      const preset = presetForRole(who, role);
      // A role's part there runs on that computer's own Who does what.
      return preset && worktree ? [{ id: role, label: `Send to ${ROLE_LABEL[role]}`, hint: machine ? `on ${machine}` : preset.name }] : [];
    });
    const sendRole = async (role: string, text: string) => (await act(() => startRole(id, role as 'design' | 'build', text).then(() => true))) === true;
    return { options, send: sendRole };
  }, [who, id, worktree, machine]);
  // Sidebars about a finding open in this page's tools column (asides.ts); what one concluded comes back into this message box, unsent.
  const asideCalls = useRef({ show: panes.showAside, put: (_: string) => {} });
  asideCalls.current = { show: panes.showAside, put: (text: string) => setInject({ id, text, n: Date.now(), append: true }) };
  const openAsideId = open.aside ? panes.state.asideId : null;
  const asideHost = useMemo<AsideHost>(() => ({ sessionId: id, openId: openAsideId, show: (asideId) => asideCalls.current.show(asideId), putInMessageBox: (text) => asideCalls.current.put(text) }), [id, openAsideId]);
  if (!session) return <section className="session-workspace"><div className="empty-list pad">{loaded ? 'This session no longer exists.' : 'Loading…'}</div></section>;

  const settings = live?.settings ?? detail?.settings;
  const current: Controls = { agent: session.agent, model: pending.model ?? settings?.model ?? '', effort: pending.effort ?? settings?.effort ?? '', fast: pending.fast ?? settings?.fast ?? false, permission: pending.permission ?? settings?.permission ?? (session.startedIn ? 'ask' : 'readonly'), projectId: session.startedIn, groupId: session.groupId };
  const change = changedSettings(pending, settings);
  const changed = Object.keys(change).length > 0;
  const projectIsPlain = sessionFolder(session, projects.find((p) => p.id === session.startedIn))?.isGit === false;
  const agentCard = <SubAgentList agents={live?.subagents ?? []} openId={open.agent ? panes.state.agentId : null} onOpen={panes.toggleAgent} />;
  // The index of the message the card sits under; -1 puts it at the end.
  const anchorAt = live?.subagentsAfter ? (detail?.messages.findIndex((m) => m.id === live.subagentsAfter) ?? -1) : -1;
  const choose = (choice: string) => setInject({ id, text: `${choice}.`, n: Date.now() });
  const stepRunning = detail?.messages.at(-1)?.activity?.some((a) => a.status === 'running') ?? false;
  // A running step already says what is happening on its own line, so the turn's line stays general then.
  // It is always there while the turn runs: taking it away during steps made the text below jump.
  const workingText = stepRunning ? 'Working…' : live?.status || 'Working…';
  const waiting = waitsOnCard(session.state, detail?.messages);
  const send = async (text: string, files: AttachmentRefs | null = null) => {
    toBottom(); // sending a message always returns to the latest
    // Only what differs rides on the message: a session in Bypass on another computer keeps it while its model changes.
    const sent = await actions.reply(id, text, change, files);
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
      {/* Only when it is true and matters: the copy is behind and its computer was asked and did not answer. */}
      {machine && detail?.remote && behind && !detail.remote.reachable && (
        <div className="remote-as-of" role="status">
          <span>{notAnsweredText(machine, detail.remote.asOf)}</span>
          <button type="button" className="secondary-button small" onClick={tryAgain}>
            Try again
          </button>
        </div>
      )}
      <FilesElsewhere.Provider value={machine}>
      <AsideContext.Provider value={asideHost}>
      <PaneArea
        scopeKey={id}
        elsewhere={machine}
        state={panes.state}
        mainLabel="Session content"
        contextLabel="Details"
        onClosePane={panes.hide}
        changes={detail && <Changes detail={detail} files={detail.files} problem={live?.filesProblem ?? null} plainFolder={projectIsPlain} git={git.value} />}
        context={detail && <DetailsPanel detail={detail} controls={current} pending={changed} git={git.value} refreshKey={refreshKey} onOpenChanges={() => panes.show('changes')} />}
        agent={<SubAgentView agent={live?.subagents.find((a) => a.id === panes.state.agentId)} onClose={panes.closeAgent} />}
        aside={<AsidePane asideId={panes.state.asideId} onUse={asideHost.putInMessageBox} onShow={asideHost.show} onClose={panes.closeAside} />}
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
                <NewPullRequestView sessionId={id} doc={activeDocument} terms={terms} branch={requestBranch} uncommitted={uncommittedCount(git.value) > 0} onCreated={pullRequests.refresh} />
              )}
            </div>
          )}
        <div className="conversation" id={`${id}-conversation-panel`} role="tabpanel" tabIndex={-1} aria-label="Conversation" data-parked={docOpen} inert={docOpen}>
          <div
            className="conversation-body"
            ref={bodyRef}
            onScroll={onScroll}
          >
           <div className="conversation-inner" ref={setInner} style={{ paddingBottom: composerHeight + 96 }}>
            {!detail ? (
              <div className="muted">Loading conversation…</div>
            ) : detail.messages.length === 0 ? (
              <div className="muted">{machine && behind ? 'This computer has no copy of the conversation yet. It is read from Kestrel Connect when this computer is connected.' : 'No messages yet.'}</div>
            ) : (
              <>
                {/* The sub-agent card is part of the conversation: it sits under the message it belongs to. */}
                <MessageList
                  key={id}
                  ref={list}
                  scrollRef={bodyRef}
                  isFollowing={isFollowing}
                  initialTop={initialTop}
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
          <ToBottom away={away} running={session.state === 'running'} workingText={workingText} composerHeight={composerHeight} onClick={toBottom} />
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
                {machine && !settings ? (
                  // Its real model and mode come from its computer; nothing stands in for them until it has said.
                  <span className="ctl-note">{machine} has not said this session’s model and mode yet</span>
                ) : (
                  <ComposerControls value={current} mode="running" sessionId={id} {...(session.runsOn ? { runsOn: session.runsOn } : {})} onChange={(c) => setPending({ model: c.model, effort: c.effort ?? '', fast: c.fast ?? false, permission: c.permission })} />
                )}
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
      </AsideContext.Provider>
      </FilesElsewhere.Provider>
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

/** The model, effort, fast-mode and mode changes waiting for the next message: only those that differ from what the session has. */
function changedSettings(pending: Partial<SessionSettings>, settings: SessionSettings | undefined): Partial<SessionSettings> {
  return {
    ...(pending.model !== undefined && pending.model !== (settings?.model ?? '') ? { model: pending.model } : {}),
    ...(pending.effort !== undefined && pending.effort !== (settings?.effort ?? '') ? { effort: pending.effort } : {}),
    ...(pending.fast !== undefined && pending.fast !== (settings?.fast ?? false) ? { fast: pending.fast } : {}),
    ...(pending.permission !== undefined && pending.permission !== settings?.permission ? { permission: pending.permission } : {}),
  };
}
