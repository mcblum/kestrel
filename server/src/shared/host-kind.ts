// The two kinds of Kestrel server: the app's, started by Electron (or a checkout's dev script), and a
// worker node's, started by a service with no window (docs/designs/worker-nodes.md, section 3). Pure and
// browser-safe, beside platform.ts: the server says which one it is (`hostKind` in host.ts, decided once by
// the entry that started it) and every screen that shows a node words things to match.

export type KestrelKind = 'app' | 'node';

export const KESTREL_KINDS: readonly KestrelKind[] = ['app', 'node'];

/** What each kind is called in a sentence. */
export const KIND_NAME: Record<KestrelKind, string> = { app: 'Kestrel app', node: 'worker node' };

/** A computer with no window of its own. */
export const hasNoWindow = (kind: KestrelKind): boolean => kind === 'node';
