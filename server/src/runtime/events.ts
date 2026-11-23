// What a session's agent reports, applied to its live record and transcript: the live patch goes out
// at once on the session's own channel, and the slower work (the row's state, storing, filing, the
// news for whoever waits) is chained after the session's earlier side effects. A turn's end is here
// too (`turnEnded`): its order is what delegation and the queue rely on. Moved out of runtime.ts as
// it was (0.0.18).
import type { AgentEvent } from '../agents/types.ts';
import { AGENT_LABEL, type Agent } from '../model.ts';
import type { ContextUsage } from '../shared/context-usage.ts';
import { addTurnCost } from '../shared/details.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import { afterTurn, shouldFlush } from '../shared/queue.ts';
import { appendSubagentOutput, isSubagentTool } from '../shared/subagents.ts';
import { appendOutput, liveStatus } from '../transcript.ts';
import { ACTIVITY, type RuntimeHost } from './host.ts';
import { imageCard } from './images.ts';
import { pickedUp, runEnded, unread } from './mid-turn.ts';
import { noteFromText, trackSubagent, type Live } from './record.ts';

/** The events `onAgentEvent` deals with before the turn's own (`applyTurnEvent`). */
type TurnEvent = Exclude<AgentEvent, { type: 'context' | 'picked-up' | 'unread' | 'outside-allowed' | 'slash-commands' | 'tool-output' | 'background-ended' | 'background-tasks' | 'image' | 'mode' | 'subagent-output' }>;

export type EventHost = Pick<RuntimeHost, 'workspace' | 'agents' | 'upkeep' | 'background' | 'commands' | 'delegation' | 'display' | 'midTurn' | 'emitLive' | 'apply' | 'queue' | 'setQueue' | 'flushQueue' | 'turnComplete'>;

/** How full the context window is, as last measured: kept on the record and sent to watchers. */
export function noteContext(host: Pick<RuntimeHost, 'emitLive'>, id: string, rec: Live, usage: ContextUsage): void {
  rec.context = usage;
  host.emitLive(id, { context: usage });
}

function agentOf(host: Pick<RuntimeHost, 'agents'>, sessionId: string): Agent {
  return host.agents.get(sessionId) ?? 'claude';
}

/** What the agent reported, applied: live at once, and the slower work chained (`sideEffects`). */
export function onAgentEvent(host: EventHost, id: string, rec: Live, event: AgentEvent): void {
  if (event.type === 'started') {
    rec.agentSessionId = event.agentSessionId;
    rec.kestrelTools = event.kestrelTools;
    rec.kestrelMissing = event.missing ?? [];
    host.emitLive(id, { kestrelTools: rec.kestrelTools, kestrelMissing: rec.kestrelMissing });
  }
  if (event.type === 'context') return noteContext(host, id, rec, event.usage);
  if (event.type === 'picked-up') return pickedUp(host.midTurn, id, rec, event.ids);
  if (event.type === 'unread') return unread(host.midTurn, id, rec, event.ids);
  if (event.type === 'outside-allowed') {
    rec.outsideAllowed = true;
    return host.upkeep.schedulePersist(id, rec);
  }
  if (event.type === 'slash-commands') {
    // Kept with the session and sent to whoever watches it; the same list is not sent twice.
    if (JSON.stringify(rec.slashCommands) === JSON.stringify(event.commands)) return;
    rec.slashCommands = event.commands;
    host.emitLive(id, { slashCommands: event.commands });
    return host.upkeep.schedulePersist(id, rec);
  }
  host.commands.apply(id, AGENT_LABEL[agentOf(host, id)], event, rec.handle);
  if (event.type === 'tool-output' || event.type === 'background-ended') return;
  if (event.type === 'background-tasks') return host.background.replace(id, event.tasks);
  // The agent's process (re)started or its turn ended: its background list starts over.
  if (event.type === 'started' || event.type === 'done' || event.type === 'failed') host.background.clear(id);
  if (event.type === 'image') return showImage(host, id, rec, event);
  if (event.type === 'mode') return leavePlan(host, id, rec, event.permission);
  if (event.type === 'subagent-output') {
    // Beside the conversation, never in it, and never stored.
    rec.subagents = appendSubagentOutput(rec.subagents, event.id, event.text);
    return host.emitLive(id, { subagents: rec.subagents });
  }
  applyTurnEvent(host, id, rec, event);
}

/** The rest of `onAgentEvent`: an event that belongs to the turn and its transcript. */
function applyTurnEvent(host: EventHost, id: string, rec: Live, event: TurnEvent): void {
  // The user already saw this turn end when the agent went quiet on background work: its run's own
  // end, when that work is over, only settles the accounts (see sideEffects).
  const quiet = event.type === 'done' && rec.endedForUser;
  if (event.type === 'phase') rec.endedForUser = event.phase === 'background';
  if (event.type === 'done' || event.type === 'failed') {
    rec.endedForUser = false;
    runEnded(rec);
  }
  const status = liveStatus(event);
  if (status !== undefined) host.emitLive(id, { status });
  if (event.type === 'status') return; // live only: nothing to store
  if (event.type === 'needs-input') rec.pendingInput.add(event.request.id);
  host.apply(id, rec, event);
  if (event.type === 'tool' && isSubagentTool(event.name)) host.emitLive(id, trackSubagent(rec, event));
  if (event.type === 'files-changed') return host.upkeep.scheduleRefresh(id, rec);
  if (event.type === 'tool' && event.status === 'started') host.upkeep.noteLatest(id, rec, event.summary);
  else if (event.type === 'message' && event.done && event.text.trim()) host.upkeep.noteLatest(id, rec, noteFromText(event.text));
  host.queue(rec, () => sideEffects(host, id, rec, event, quiet));
}

async function sideEffects(host: EventHost, id: string, rec: Live, event: AgentEvent, quiet = false): Promise<void> {
  switch (event.type) {
    case 'started':
      await host.workspace.setState(id, 'running', 'Working…');
      return host.upkeep.persist(id, rec);
    case 'needs-input':
      await host.workspace.setState(id, 'attention', `Needs you · ${event.request.title}`, ACTIVITY);
      await host.upkeep.persist(id, rec);
      return host.delegation.onChildState(id, 'attention', event.request.title);
    case 'done':
      rec.usage = addTurnCost(rec.usage, event.costUsd);
      if (!quiet) return turnEnded(host, id, rec, event.reason);
      await host.upkeep.refreshFiles(id, rec);
      return host.upkeep.flush(id, rec);
    case 'phase':
      // Quiet on background work, the turn is over for the user: the session reads as finished
      // and takes messages, which go into the live run (agents/types.ts).
      if (event.phase === 'background') return turnEnded(host, id, rec, 'complete');
      // It woke by itself (something it left running finished): working again.
      await host.workspace.setState(id, 'running', 'Working…', ACTIVITY);
      return host.delegation.onSessionRunning(id);
    case 'failed':
      return turnFailed(host, id, rec, event);
    default:
  }
}

async function turnFailed(host: EventHost, id: string, rec: Live, event: Extract<AgentEvent, { type: 'failed' }>): Promise<void> {
  host.upkeep.cancelRefresh(rec);
  host.upkeep.cancelNote(rec);
  rec.pendingInput.clear();
  host.setQueue(id, rec, afterTurn(rec.queue, 'failed'));
  await host.upkeep.refreshFiles(id, rec);
  await host.workspace.setState(id, 'attention', event.kind === 'auth' ? `${AGENT_LABEL[(await host.workspace.state()).sessions.find((s) => s.id === id)?.agent ?? 'claude']} is not signed in` : `Failed · ${event.reason.slice(0, 120)}`, ACTIVITY);
  await host.upkeep.flush(id, rec);
  releaseWaiters(rec);
  return host.delegation.onChildState(id, 'attention', `failed: ${event.reason.slice(0, 160)}`);
}

/**
 * A turn ended for the user: the session is done (or stopped), its files are refreshed, whoever
 * waited on it hears, and what was queued meanwhile goes as the next turn.
 */
async function turnEnded(host: EventHost, id: string, rec: Live, reason: 'complete' | 'stopped'): Promise<void> {
  host.upkeep.cancelRefresh(rec);
  host.upkeep.cancelNote(rec);
  rec.pendingInput.clear();
  const end = reason === 'stopped' || rec.stopped ? 'stopped' : 'complete';
  const flush = shouldFlush(rec.queue, end);
  host.setQueue(id, rec, afterTurn(rec.queue, end));
  await host.upkeep.refreshFiles(id, rec);
  await host.workspace.setState(id, 'done', await host.delegation.doneNote(id, end === 'stopped'), { ...ACTIVITY, completed: end === 'complete', stopped: end === 'stopped' });
  await host.upkeep.flush(id, rec);
  releaseWaiters(rec);
  if (reason !== 'stopped') await host.delegation.onChildState(id, 'done', '');
  if (end === 'complete') host.turnComplete(id);
  // The user's queued messages are the next turn; news from other sessions goes along with them.
  if (flush && rec.queue.items.length > 0 && !rec.handle?.busy()) return host.flushQueue(id);
  return host.delegation.drainInbox(id);
}

/** A picture a tool returned: stored under the session's media folder, shown under that tool's result (runtime/images.ts). */
export function showImage(host: Pick<RuntimeHost, 'display' | 'apply' | 'emitLive'>, id: string, rec: Live, event: Extract<AgentEvent, { type: 'image' }>): void {
  const shown = imageCard(host.display, id, rec.messages, event);
  if ('card' in shown) return host.apply(id, rec, shown.card);
  rec.agentOutput = appendOutput(rec.agentOutput, shown.output);
  host.emitLive(id, { agentOutput: rec.agentOutput });
}

/**
 * The user approved a plan and picked a level. The handle already runs at it, so unlike a
 * settings change between turns it is kept: this turn goes on.
 */
function leavePlan(host: Pick<RuntimeHost, 'emitLive' | 'upkeep'>, id: string, rec: Live, permission: PermissionLevel): void {
  if (rec.settings.permission === permission) return;
  rec.settings = { ...rec.settings, permission };
  host.emitLive(id, { settings: rec.settings });
  host.upkeep.schedulePersist(id, rec);
}

function releaseWaiters(rec: Live): void {
  for (const resolve of rec.turnWaiters.splice(0)) resolve();
}
