// For a session another session started: the live check its agent reads before a command that leaves its sandbox
// asks (issue 74; the rule is shared/sandbox-inherit.ts). The chain of sessions that started it is found once, when
// its agent starts (a handoff or delegate link, or the spawner its record keeps); each mode in it, and the switch,
// are read as they are at the command, so changing a mode or the switch counts from the next command.
import type { OutsideInherit } from '../agents/types.ts';
import { inheritsOutside, offersInherit } from '../shared/sandbox-inherit.ts';
import type { PermissionLevel } from '../shared/permissions.ts';
import { startLinkOf } from '../tree.ts';
import type { RuntimeHost } from './host.ts';

/** How far up a chain of starters is followed; delegation limits keep real chains far shorter. */
const CHAIN_MAX = 20;
/** The mode taken for a starter whose settings cannot be read (deleted, never run): it would be asked. */
const UNKNOWN_MODE: PermissionLevel = 'ask';

export type InheritHost = Pick<RuntimeHost, 'workspace' | 'records' | 'sandboxAllow'>;

interface Starter {
  id: string;
  /** Its mode when the chain was read: used while it is not loaded. */
  mode: PermissionLevel;
}

async function spawnerOf(host: InheritHost, id: string): Promise<string | null> {
  const live = host.records.get(id);
  if (live) return live.spawnedBy;
  return (await host.workspace.storedDetail(id))?.spawnedBy ?? null;
}

async function modeOf(host: InheritHost, id: string): Promise<PermissionLevel> {
  return host.records.get(id)?.settings.permission ?? (await host.workspace.storedDetail(id))?.settings?.permission ?? UNKNOWN_MODE;
}

/** The sessions that started `sessionId`, nearest first, up to the one the user started. */
export async function startersOf(host: InheritHost, sessionId: string): Promise<Starter[]> {
  const { links } = await host.workspace.state();
  const out: Starter[] = [];
  const seen = new Set([sessionId]);
  let current = sessionId;
  while (out.length < CHAIN_MAX) {
    const up = startLinkOf(current, links)?.parentId ?? (await spawnerOf(host, current));
    if (!up || seen.has(up)) break;
    seen.add(up);
    out.push({ id: up, mode: await modeOf(host, up) });
    current = up;
  }
  return out;
}

/** What a session's agent is handed, or undefined for a session the user started (nothing started it). */
export async function outsideInheritFor(host: InheritHost, sessionId: string, ownMode: PermissionLevel): Promise<OutsideInherit | undefined> {
  const starters = await startersOf(host, sessionId);
  if (starters.length === 0) return undefined;
  const chain = (): PermissionLevel[] => [host.records.get(sessionId)?.settings.permission ?? ownMode, ...starters.map((s) => host.records.get(s.id)?.settings.permission ?? s.mode)];
  return {
    allows: () => inheritsOutside(chain(), host.sandboxAllow.inherits()),
    offerable: () => offersInherit(chain(), host.sandboxAllow.inherits()),
  };
}
