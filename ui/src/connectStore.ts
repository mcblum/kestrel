// Kestrel Connect outside React. Its state is the store's `connect` slice (this module owns the
// writes), filled from the server's `connect-state` push and from the answer to each action; the
// server holds the one copy (server/src/connect/link/connect.ts). Registered on import.
import type { ConnectView } from '@kestrel/server/connect';
import { act, appStore, call, connectSocket, setApp, useApp } from './store.ts';
import { toasts } from './toasts.ts';

export const CONNECT_PATH = '/api/connect';

const put = (view: ConnectView | undefined) => {
  if (!view) return;
  const before = appStore.get().connect;
  // A device that was not in the account a moment ago and is now: say so.
  if (before) for (const device of view.devices) if (device.inAccount && !device.here && before.devices.some((d) => d.id === device.id && !d.inAccount)) toasts.show(`${device.name} is in your account`);
  setApp({ connect: view });
};

connectSocket.register({
  message: (message) => {
    if (message.type === 'connect-state') put(message.view as ConnectView);
  },
  // The push on connect may have come before this module was loaded: ask once.
  opened: () => void call<ConnectView>(CONNECT_PATH).then(put, () => undefined),
});

export const useConnect = (): ConnectView | null => useApp((s) => s.connect);

export const connectActions = {
  setEnabled: async (enabled: boolean) => put(await act(() => call<ConnectView>(CONNECT_PATH, { method: 'PATCH', body: JSON.stringify({ enabled }) }))),
  /** Starts a sign-in and opens the sign-in page in the browser. */
  signIn: async () => {
    const answer = await act(() => call<{ url: string }>(`${CONNECT_PATH}/sign-in`, { method: 'POST' }));
    if (answer) window.open(answer.url, '_blank', 'noopener');
  },
  cancelSignIn: () => act(() => call(`${CONNECT_PATH}/sign-in`, { method: 'DELETE' })),
  signOut: async () => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/sign-out`, { method: 'POST' }))),
  /** This computer asks again to be let into the account. */
  askToJoin: async () => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/join`, { method: 'POST' }))),
  /** The second code, shown on the device that let this computer in; true when it was right. */
  confirmJoin: async (code: string) => {
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/join/confirm`, { method: 'POST', body: JSON.stringify({ code }) }));
    put(view);
    return view !== undefined && view !== null;
  },
  /** The key offered is not kept. */
  cancelJoin: async () => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/join/cancel`, { method: 'POST' }))),
  /** The second code was typed on the other device: stop showing it. */
  dismissRequest: async (id: string) => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/requests/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }))),
  /** Starts letting another device in; its code is typed next. */
  openRequest: async (id: string) => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/requests/${encodeURIComponent(id)}/open`, { method: 'POST' }))),
  /** The code the other device shows; true when it was right. A wrong one's reason shows on the request and in the toast stack. */
  typeCode: async (id: string, code: string) => {
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/requests/${encodeURIComponent(id)}/code`, { method: 'POST', body: JSON.stringify({ code }) }));
    put(view);
    return view !== undefined && view !== null;
  },
  /** Not me: the request is refused, and the device is told. */
  refuseRequest: async (id: string) => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/requests/${encodeURIComponent(id)}/refuse`, { method: 'POST' }))),
  /** Which projects are kept off Kestrel Connect, and whether attachments are held. Saved as changed. */
  setHeld: async (change: { keptOff?: string[]; attachments?: boolean }) => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/held`, { method: 'PATCH', body: JSON.stringify(change) }))),
  /** The recovery words: the answer to this one action, kept by the page that asked, never in the store. */
  recoveryWords: async () => (await act(() => call<{ words: string[] }>(`${CONNECT_PATH}/recovery`)))?.words ?? null,
  recoveryPutAway: async () => put(await act(() => call<ConnectView>(`${CONNECT_PATH}/recovery/put-away`, { method: 'POST' }))),
  /** Lets this computer in with the 24 words; true when it was. */
  recover: async (words: string) => {
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/recovery`, { method: 'POST', body: JSON.stringify({ words }) }));
    put(view);
    return view !== undefined && view !== null;
  },
  /** Names this computer ('' is its host name); true when it was stored. */
  setName: async (name: string) => {
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/name`, { method: 'PATCH', body: JSON.stringify({ name }) }));
    put(view);
    return view !== undefined && view !== null;
  },
  /** Renames a device of the account (a label only); true when the service took it. */
  renameDevice: async (id: string, name: string) => {
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
    put(view);
    return view !== undefined && view !== null;
  },
  /** Ends a device's access at once, removes it from the account and changes the account key. It cannot be undone, so it asks first. */
  removeDevice: async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from your Kestrel Connect account? It can no longer reach this computer, and your account key and recovery key are replaced so it cannot read what is held from now on. To use it again, let it in again.`)) return;
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!view) return;
    setApp({ connect: view });
    toasts.show(`Removed ${name}`);
  },
};
