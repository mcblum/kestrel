// Connecting Jira Cloud (Settings → Tickets; docs/designs/tickets.md, section 3): the user types
// the site and the account's email and pastes an API token; Kestrel asks Jira who that is before it
// keeps anything, then keeps all three in the credential store (credentials.ts). Only the user
// connects or disconnects: no Kestrel tool can. What Settings is told never includes the token.
import type { ConnectStorage } from '../shared/connect.ts';
import { reasonOf } from '../shared/sourced.ts';
import { Refused } from '../refused.ts';
import type { CredentialStore } from './credentials.ts';
import type { TicketSource } from './source.ts';
import { jiraClient, jiraTicketSource, jiraWhoAmI, siteHost } from './sources/jira.ts';

export interface JiraConnectionView {
  connected: boolean;
  site: string | null;
  email: string | null;
  name: string | null;
  /** Where the token is kept: the OS keystore, or a file only the user can read. */
  storage: ConnectStorage;
  /** Why it cannot be connected here (sample data), or null. */
  unavailable: string | null;
}

type Fetcher = Parameters<typeof jiraClient>[1];

export const SAMPLE_TRACKERS_REASON = 'This copy of Kestrel is showing sample data, so it asks no tracker. Connect a tracker from your own Kestrel.';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class JiraConnection {
  private source: { token: string; site: string; email: string; value: TicketSource } | null = null;

  constructor(
    private readonly store: CredentialStore,
    private readonly options: { fetcher?: Fetcher; unavailable?: string | null; changed?: () => void } = {},
  ) {}

  async view(): Promise<JiraConnectionView> {
    const jira = (await this.store.read()).jira;
    return { connected: jira !== null, site: jira?.site ?? null, email: jira?.email ?? null, name: jira?.name ?? null, storage: this.store.storage, unavailable: this.options.unavailable ?? null };
  }

  /** Check the details with Jira, then keep them. Throws `Refused` with what to fix. */
  async connect(input: { site: unknown; email: unknown; token: unknown }): Promise<JiraConnectionView> {
    if (this.options.unavailable) throw new Refused(this.options.unavailable);
    const site = typeof input.site === 'string' ? siteHost(input.site) : null;
    if (!site) throw new Refused('Write the Jira Cloud site’s address, like your-team.atlassian.net. Kestrel sends the token only to an atlassian.net or jira.com site; Jira Server and Data Center are not supported yet.');
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (!EMAIL.test(email)) throw new Refused('Write the email address of your Atlassian account.');
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!token) throw new Refused('Paste an API token: make one at id.atlassian.com → Security → API tokens.');
    let name: string;
    try {
      name = await jiraWhoAmI(jiraClient({ site, email, token }, this.options.fetcher));
    } catch (error) {
      throw new Refused(reasonOf(error));
    }
    await this.store.write({ ...(await this.store.read()), jira: { site, email, token, name } });
    this.options.changed?.();
    return this.view();
  }

  async disconnect(): Promise<JiraConnectionView> {
    await this.store.write({ ...(await this.store.read()), jira: null });
    this.source = null;
    this.options.changed?.();
    return this.view();
  }

  /** Jira's ticket source while it is connected, else null. The same source while the details are the same. */
  async ticketSource(): Promise<TicketSource | null> {
    if (this.options.unavailable) return null;
    const jira = (await this.store.read()).jira;
    if (!jira) return (this.source = null);
    if (this.source && this.source.token === jira.token && this.source.site === jira.site && this.source.email === jira.email) return this.source.value;
    const value = jiraTicketSource(jira, this.options.fetcher);
    this.source = { token: jira.token, site: jira.site, email: jira.email, value };
    return value;
  }
}
