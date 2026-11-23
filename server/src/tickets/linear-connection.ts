// Connecting Linear (Settings → Tickets → Sources): the user pastes a personal API key; Kestrel asks
// Linear who that is before it keeps anything, then keeps it in the credential store (credentials.ts),
// beside Jira's. Only the user connects or disconnects: no Kestrel tool can. What Settings is told
// never includes the key. OAuth is for later; nothing is registered with Linear.
import type { ConnectStorage } from '../shared/connect.ts';
import { reasonOf } from '../shared/sourced.ts';
import { Refused } from '../refused.ts';
import type { CredentialStore } from './credentials.ts';
import type { TicketSource } from './source.ts';
import { linearClient, linearTicketSource, linearWhoAmI, type LinearFetch } from './sources/linear.ts';

export interface LinearConnectionView {
  connected: boolean;
  name: string | null;
  storage: ConnectStorage;
  /** Why it cannot be connected here (sample data), or null. */
  unavailable: string | null;
}

export class LinearConnection {
  private source: { key: string; value: TicketSource } | null = null;

  constructor(
    private readonly store: CredentialStore,
    private readonly options: { fetcher?: LinearFetch; unavailable?: string | null; changed?: () => void } = {},
  ) {}

  async view(): Promise<LinearConnectionView> {
    const linear = (await this.store.read()).linear;
    return { connected: linear !== null, name: linear?.name ?? null, storage: this.store.storage, unavailable: this.options.unavailable ?? null };
  }

  /** Check the key with Linear, then keep it. Throws `Refused` with what to fix. */
  async connect(input: { key: unknown }): Promise<LinearConnectionView> {
    if (this.options.unavailable) throw new Refused(this.options.unavailable);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!key) throw new Refused('Paste a personal API key: make one in Linear under Settings → Security & access → Personal API keys.');
    let name: string;
    try {
      name = await linearWhoAmI(linearClient(key, this.options.fetcher));
    } catch (error) {
      throw new Refused(reasonOf(error));
    }
    await this.store.write({ ...(await this.store.read()), linear: { key, name } });
    this.options.changed?.();
    return this.view();
  }

  async disconnect(): Promise<LinearConnectionView> {
    await this.store.write({ ...(await this.store.read()), linear: null });
    this.source = null;
    this.options.changed?.();
    return this.view();
  }

  /** Linear's ticket source while it is connected, else null. The same source while the key is the same. */
  async ticketSource(): Promise<TicketSource | null> {
    if (this.options.unavailable) return null;
    const linear = (await this.store.read()).linear;
    if (!linear) return (this.source = null);
    if (this.source?.key === linear.key) return this.source.value;
    const value = linearTicketSource(linear.key, this.options.fetcher);
    this.source = { key: linear.key, value };
    return value;
  }
}
