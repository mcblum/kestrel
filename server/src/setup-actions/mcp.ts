// Set up this computer's MCP step (docs/designs/onboarding.md, 18.2): the other computer's definition
// goes into Kestrel's own list (McpServerStore), never into an agent's file. Values never travel: every
// environment variable and header becomes a secret slot with nothing in it, entered on the server's own
// page; an argument or a part of the address that was left out (it looked like a key) cannot be held as a
// slot, so such a server is refused with where to add it by hand. A `~/` path becomes this home folder's.
import type { McpServerStore } from '../mcp-servers/store.ts';
import { Refused } from '../refused.ts';
import { blankText, type SetupMcpServer } from '../shared/setup-record.ts';
import { listNameOf, type McpServerView } from '../shared/mcp-servers.ts';
import { homePathHere, type McpTarget } from './execute.ts';

export type McpStoreLike = Pick<McpServerStore, 'save' | 'remove' | 'list'>;

/** A `~/…` path as this computer's; anything else as it is. Null when it would leave the home folder. */
function pathHere(value: string, home: string): string | null {
  return value === '~' || value.startsWith('~/') ? homePathHere(value, home) : value;
}

/** The raw input McpServerStore takes, for a definition from another computer. Refused with the reason. Pure. */
export function mcpInputOf(server: SetupMcpServer, home: string): Record<string, unknown> {
  const unheld = server.blanks.filter((b) => b.kind !== 'env' && b.kind !== 'header');
  if (unheld.length > 0) throw new Refused(`${server.name} has ${unheld.map(blankText).join(' and ')} left out (it looked like a key), which Kestrel cannot hold as a value to enter. Add it in Settings → Agent setup → MCP servers and type it there.`);
  const slot = (key: string) => ({ key, secret: true });
  if (server.transport === 'stdio') {
    if (!server.command) throw new Refused(`${server.name}'s command was left out, so it cannot be added from here.`);
    const command = pathHere(server.command, home);
    if (command === null) throw new Refused(`${server.name}'s command points outside the home folder.`);
    const args = server.args.map((a) => (a === null ? null : pathHere(a, home)));
    if (args.some((a) => a === null)) throw new Refused(`An argument of ${server.name} points outside the home folder.`);
    return { name: listNameOf(server.name), kind: 'stdio', command, args, env: server.env.map(slot), headers: [], projectId: null };
  }
  if (!server.url) throw new Refused(`${server.name}'s address was left out, so it cannot be added from here.`);
  return { name: listNameOf(server.name), kind: server.transport, url: server.url, env: [], headers: server.headers.map(slot), projectId: null };
}

/** Whether Kestrel's list has the server, and whether every value it needs is set. Pure. */
export function mcpStateOf(view: McpServerView | undefined): 'missing' | 'needs-values' | 'ready' {
  if (!view) return 'missing';
  return [...view.env, ...view.headers].every((v) => v.set) ? 'ready' : 'needs-values';
}

/** The names of a server in Kestrel's list with no value here; null when it is not in the list. Pure. */
export function mcpMissingOf(view: McpServerView | undefined): string[] | null {
  return view ? [...view.env, ...view.headers].filter((v) => !v.set).map((v) => v.key) : null;
}

/** The step's target: adds to Kestrel's list; Undo removes the server it added. */
export function mcpTarget(store: McpStoreLike): McpTarget {
  return {
    add: async (server, home) => {
      const view = await store.save(null, mcpInputOf(server, home));
      const missing = [...view.env, ...view.headers].filter((v) => !v.set).map((v) => v.key);
      // Said when the list could not take the name as it was ("Home Assistant" is Home-Assistant there).
      const as = view.name === server.name ? '' : ` as ${view.name}`;
      const said = missing.length > 0 ? `Added to Kestrel's MCP servers${as}, without its values. It still needs ${missing.join(', ')}: copy them from a computer that has them, or enter them on its page.` : `Added to Kestrel's MCP servers${as}.`;
      return { said, undo: () => store.remove(view.name) };
    },
  };
}
