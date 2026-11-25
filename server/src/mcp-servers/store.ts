// Kestrel's list of MCP servers (docs/designs/mcp-servers.md): each server's definition in the
// database through the persistence facade (one setting, `mcp-servers`), its secret values in the sealed
// store (secrets.ts). The split is shared/mcp-servers.ts's; nothing here returns a secret value except
// `forSession`, whose answer goes only into the configuration an agent is handed.
//
// A server for every project is switched on in the defaults and every project's own setup when it is
// added, and off everywhere when it is removed or moved to one project (workspace-settings.ts), in the
// same transaction as the list.
import type { Persistence } from '../persistence/types.ts';
import { Refused } from '../refused.ts';
import type { McpConfig } from '../shared/setup.ts';
import { asServerDefs, kestrelServersFor, mergeServers, nextSecrets, parseServerInput, serverConfig, serverView, type HandedServer, type McpServerDef, type McpServerView } from '../shared/mcp-servers.ts';
import { switchServerEverywhere } from '../workspace-settings.ts';
import type { McpSecretStore } from './secrets.ts';

export const MCP_SERVERS_KEY = 'mcp-servers';

async function readDefs(db: Pick<Persistence, 'getSetting'>): Promise<McpServerDef[]> {
  try {
    return asServerDefs(JSON.parse((await db.getSetting(MCP_SERVERS_KEY)) ?? '[]'));
  } catch {
    return [];
  }
}

/** The list as the UI and other parts of Kestrel see it. */
export interface McpServerList {
  servers: McpServerView[];
  /** Where the values are kept: the OS keystore, or a file only the user can read. */
  storage: McpSecretStore['storage'];
}

export class McpServerStore {
  /** Secret writes run one after another, so two saves cannot drop each other's values. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Persistence,
    private readonly secrets: McpSecretStore,
  ) {}

  defs(): Promise<McpServerDef[]> {
    return readDefs(this.db);
  }

  /** Every server, without a secret value: the names of its secrets and whether each is set. */
  async list(): Promise<McpServerList> {
    const [defs, stored] = await Promise.all([this.defs(), this.secrets.read()]);
    return { servers: defs.map((d) => serverView(d, stored[d.name])), storage: this.secrets.storage };
  }

  async view(name: string): Promise<McpServerView> {
    const { servers } = await this.list();
    const found = servers.find((s) => s.name === name);
    if (!found) throw new Refused(`No MCP server named ${name}.`);
    return found;
  }

  /**
   * Adds a server (`name` null) or changes the one named. The name of a server cannot change: its
   * name is what the setup lists and its values are kept by. Values typed are sealed; a secret left
   * empty keeps what it had.
   */
  async save(name: string | null, raw: unknown): Promise<McpServerView> {
    const projectIds = (await this.db.listProjects()).map((p) => p.id);
    const input = parseServerInput(raw, projectIds);
    if (name !== null && input.def.name !== name) throw new Refused("A server's name cannot be changed. Remove it and add it again under the new name.");
    await this.db.transaction(async (tx) => {
      const defs = await readDefs(tx);
      const before = defs.find((d) => d.name === input.def.name);
      if (name === null && before) throw new Refused(`There is already an MCP server named ${input.def.name}.`);
      if (name !== null && !before) throw new Refused(`No MCP server named ${name}.`);
      const next = before ? defs.map((d) => (d.name === input.def.name ? input.def : d)) : [...defs, input.def];
      await tx.putSetting(MCP_SERVERS_KEY, JSON.stringify(next));
      // Added for every project, or moved there: on everywhere. Moved to one project: off in the lists.
      const wasEvery = before !== undefined && before.projectId === null;
      const isEvery = input.def.projectId === null;
      if (isEvery && !wasEvery) await switchServerEverywhere(tx, input.def.name, true);
      if (!isEvery && wasEvery) await switchServerEverywhere(tx, input.def.name, false);
    });
    await this.writeSecrets((all) => ({ ...all, [input.def.name]: nextSecrets(input.def, all[input.def.name] ?? {}, input.typed, input.cleared) }));
    return this.view(input.def.name);
  }

  /** Removes a server and deletes its values. Cannot be undone. */
  async remove(name: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const defs = await readDefs(tx);
      if (!defs.some((d) => d.name === name)) throw new Refused(`No MCP server named ${name}.`);
      await tx.putSetting(MCP_SERVERS_KEY, JSON.stringify(defs.filter((d) => d.name !== name)));
      await switchServerEverywhere(tx, name, false);
    });
    await this.writeSecrets(({ [name]: _gone, ...rest }) => rest);
  }

  /**
   * The servers a session starts with: the found ones switched on (`found`), and Kestrel's own by the
   * rule in shared/mcp-servers.ts, with their values. Built once per start; the answer goes only into
   * the configuration the agent is handed.
   */
  async forSession(switchedOn: readonly string[], projectId: string | null, found: Record<string, McpConfig>): Promise<{ mcpServers: Record<string, McpConfig>; handed: HandedServer[] }> {
    const defs = kestrelServersFor(await this.defs(), switchedOn, projectId);
    return mergeServers(found, defs, defs.length ? await this.secrets.read() : {});
  }

  /** One server's configuration with its values, for Settings' Test only (probe.ts). */
  async configOf(name: string): Promise<McpConfig> {
    const def = (await this.defs()).find((d) => d.name === name);
    if (!def) throw new Refused(`No MCP server named ${name}.`);
    return serverConfig(def, (await this.secrets.read())[name] ?? {});
  }

  private writeSecrets(change: (all: Awaited<ReturnType<McpSecretStore['read']>>) => Awaited<ReturnType<McpSecretStore['read']>>): Promise<void> {
    const work = this.writes.then(async () => this.secrets.write(change(await this.secrets.read())));
    this.writes = work.catch(() => undefined);
    return work;
  }
}

