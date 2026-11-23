// Kestrel Connect outside React. Its state is the store's `connect` slice (this module owns the
// writes), filled from the server's `connect-state` push and from the answer to each action; the
// server holds the one copy (server/src/connect/link/connect.ts). Registered on import.
import type { ConnectView, PairingOffer } from '@kestrel/server/connect';
import { act, appStore, call, connectSocket, setApp, useApp } from './store.ts';
import { toasts } from './toasts.ts';

export const CONNECT_PATH = '/api/connect';

const put = (view: ConnectView | undefined) => {
  if (!view) return;
  const before = appStore.get().connect;
  // A phone that was not paired a moment ago and is now: say so (design doc, section 9).
  if (before) for (const device of view.paired) if (!before.paired.some((d) => d.id === device.id)) toasts.show(`Paired ${device.name}`);
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
  /** Shows a pairing code; the pushed view carries it to the page. */
  startPairing: () => act(() => call<PairingOffer>(`${CONNECT_PATH}/pairing`, { method: 'POST' })),
  stopPairing: () => act(() => call(`${CONNECT_PATH}/pairing`, { method: 'DELETE' })),
  /** Ends a device's access at once. It cannot be undone, so it asks first. */
  removeDevice: async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name}? It can no longer reach this computer until it is paired again.`)) return;
    const view = await act(() => call<ConnectView>(`${CONNECT_PATH}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!view) return;
    setApp({ connect: view });
    toasts.show(`Removed ${name}`);
  },
};
