// Sidebars (server: shared/asides.ts, asides.ts): side conversations started from a point of a
// session's conversation. A caller (a message's foot, a finding's control) asks the server for the
// sidebar with its key (the one there is, or a new one) and opens it in the pane column of the
// session page. The sidebar itself is server data like any session: its record is in the store's
// workspace, its conversation in the store's details and live slices. What this file holds is only
// which pane shows it, given by the session page.
import { createContext, useContext } from 'react';
import type { Session } from '@kestrel/server/model';
import type { AsideSubject } from '@kestrel/server/asides';
import { act, call } from './store.ts';

/** What the session page gives the cards in its conversation. */
export interface AsideHost {
  /** The session whose conversation this is. */
  sessionId: string;
  /** The sidebar shown in the pane now, if any. */
  openId: string | null;
  /** Show this sidebar in the pane. */
  show(asideId: string): void;
  /** Put text into this session's message box, after what is there; never sent from here. */
  putInMessageBox(text: string): void;
}

export const AsideContext = createContext<AsideHost | null>(null);

/** The session page's sidebar host, or null where there is none (a conversation drawn elsewhere: no sidebars there). */
export const useAsideHost = (): AsideHost | null => useContext(AsideContext);

/** What a caller asks for: the point, which sidebar (default: one per point), and what it is about. */
export interface AsideRequest {
  at: string;
  key?: string;
  subject?: AsideSubject;
}

/** The key the server gives a sidebar asked for with none: one per point. */
export const pointKey = (at: string): string => `point:${at}`;

/** A sidebar from the server: the one there is with that key, or a new one. Null when refused (the reason is shown by `act`). */
export async function openAside(sessionId: string, request: AsideRequest): Promise<Session | null> {
  const made = await act(() => call<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/asides`, { method: 'POST', body: JSON.stringify(request) }));
  return made && typeof made === 'object' && 'session' in made ? made.session : null;
}

/** One finding action (server: finding-actions.ts). True when it went; a refusal is shown by `act`. */
export async function actOnFinding(sessionId: string, cardId: string, findingId: string, action: 'answer' | 'fix' | 'dismiss' | 'restore', text?: string): Promise<boolean> {
  const done = await act(() => call(`/api/sessions/${encodeURIComponent(sessionId)}/findings`, { method: 'POST', body: JSON.stringify({ cardId, findingId, action, ...(text !== undefined ? { text } : {}) }) }).then(() => true));
  return done === true;
}
