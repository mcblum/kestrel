// The computers a New session may run on (issue 52; server/src/shared/start-computer.ts): the account's other
// computers, asked of the server (`GET /api/start-computers`), and what each offers a session started from here
// (`GET /api/start-computers/:id`, that computer's `session.startChoices`). Both are held once in the store's
// resources, by route; this module only asks and reads them.
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Machine } from '@kestrel/server/machines';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { statusOf, type ComputerStatus, type StartComputerAnswer } from '@kestrel/server/start-computer';
import { fetchResource, useResource } from './data/resources.ts';
import { useApp, type AppState } from './store.ts';
import './connectStore.ts';

const LIST = '/api/start-computers';
export const startChoicesPath = (id: string): string => `${LIST}/${encodeURIComponent(id)}`;

const NONE: readonly Machine[] = [];
const asList = (raw: unknown): Sourced<Machine[]> => {
  const computers = (raw as { computers?: unknown })?.computers;
  return ready(Array.isArray(computers) ? (computers as Machine[]).filter((m) => typeof m?.id === 'string' && typeof m?.name === 'string') : []);
};
const asAnswer = (raw: unknown): Sourced<StartComputerAnswer> => {
  const r = raw as Partial<StartComputerAnswer> | null;
  if (r?.ok === true && 'choices' in r && r.choices) return ready({ ok: true, choices: r.choices });
  return ready({ ok: false, reason: (r as { reason?: string } | null)?.reason ?? 'Kestrel could not ask that computer.' });
};

/**
 * The account's desktops as the server pushes them with Kestrel Connect's state (`connect.devices`), as one
 * string: when a computer joins, leaves or is renamed it changes, and the list is asked for again. The server
 * keeps the one rule for which of them a session may start on (`otherComputers`).
 */
const accountDesktops = (s: AppState): string =>
  (s.connect?.devices ?? [])
    .filter((d) => d.kind === 'desktop' && !d.here)
    .map((d) => `${d.id}\t${d.name}\t${d.inAccount}`)
    .join('\n');

/** The account's other computers; empty with no account or none, null until the server has said. */
export function useOtherComputers(): readonly Machine[] | null {
  const list = useResource(LIST, asList, useApp(accountDesktops)).value;
  if (list.state === 'ready') return list.value;
  return list.state === 'loading' ? null : NONE;
}

// ---- what another computer offers: the one place it is read and asked ------------------------------------
// Read from what that computer published on Kestrel Connect, which the server pushes as the store's
// `machineOffers` slice: there at once, whether or not that computer is awake (Matt, 2026-11-26: "we should
// always be reading from the server when possible"). A computer that has published nothing (a Kestrel from
// before it did) is asked live through the server, and that answer is held as a resource by route. Every view
// reads offers through `useComputerOffers`.

/** What the store holds for that computer's offer, as it holds it (the same object while unchanged). */
const heldOffer = (s: AppState, id: string): Sourced<StartComputerAnswer> | undefined => s.resources.get(startChoicesPath(id)) as Sourced<StartComputerAnswer> | undefined;

/** What is held, as what that computer offers: still asking, cannot be asked (with why), or its choices. */
function offerOf(held: Sourced<StartComputerAnswer> | undefined): ComputerStatus {
  if (held?.state === 'unavailable') return { state: 'unreachable', reason: held.reason };
  return statusOf(held?.state === 'ready' ? held.value : null);
}

/** Asks those computers what they offer now (each time the menu opens, since reachability changes). */
function askOffers(ids: readonly string[]): void {
  for (const id of ids) void fetchResource(startChoicesPath(id), asAnswer);
}

/** What each of those computers offers, as held, every one asked again whenever `asked` changes. */
export function useComputerOffers(ids: readonly string[], asked = ''): (id: string) => ComputerStatus {
  const published = useApp(useShallow((s) => ids.map((id) => s.machineOffers[id])));
  // Only a computer with nothing published is asked, again whenever `asked` changes (its reachability may have).
  const unpublished = ids.filter((_, i) => !published[i]).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => askOffers(unpublished ? unpublished.split('\n') : []), [unpublished, asked]);
  const held = useApp(useShallow((s) => ids.map((id) => heldOffer(s, id))));
  return (id) => {
    const at = ids.indexOf(id);
    const record = published[at];
    return record ? { state: 'ready', choices: record.offers } : offerOf(held[at]);
  };
}
