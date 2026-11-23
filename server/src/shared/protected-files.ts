// Kestrel's own secrets, kept out of a confined session's reach (Matt, 2026-11-22). The protected store's
// files live in Kestrel's data folder: the tracker credentials (tickets/credentials.ts) and Kestrel
// Connect's sign-in and device keys (connect/link/vault.ts), each sealed under a key the app keeps in the
// OS keystore, or a plain file only the user can read where there is none. A session another session
// started (`confineShell`) may not read, search or write them, for every provider:
// - every tool call Kestrel sees (Claude's hook, a Codex or OpenCode ask) is checked here first, through
//   the adapter's `intercept`: a file tool aimed at one, a search over a folder holding one, or a command
//   that names one is refused, in every mode, whatever the always-allowed list says;
// - a Claude child's commands also run in an OS sandbox that cannot read them (agents/claude/sandbox.ts).
// What is not covered is in the design doc ("Kestrel's own secrets"). Pure: the caller resolves paths.

/** The protected store's files in the data folder: sealed, and the plain fallbacks where there is no keystore. */
export const PROTECTED_FILES = {
  trackersSealed: 'trackers.sealed',
  trackersPlain: 'trackers.json',
  connectSealed: 'connect.sealed',
  connectPlain: 'connect.json',
} as const;

export const PROTECTED_FILE_NAMES: readonly string[] = Object.values(PROTECTED_FILES);

/** The reason a call is refused. Said for the agent, which passes it on. */
export const PROTECTED_REFUSAL = "Kestrel: that is Kestrel's own credential store, which a session started by another session may not read, search or change. Ask the user if a tracker or Kestrel Connect needs looking at.";

/** File tools and the key holding the path each reads or writes (Claude's names; Codex and OpenCode calls are passed as these). */
const PATH_KEYS: Record<string, string> = { Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'path' };
/** The tools that search a folder: refused when the folder holds a protected file. */
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
/** Where a command's text is: Claude's Bash and PowerShell, an OpenCode bash call (`command`), a Codex ask (`detail`). */
const COMMAND_KEYS = ['command', 'detail'] as const;

const isInside = (path: string, root: string, sep: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The static folder part of an absolute glob pattern: `/a/b/*.ts` is `/a/b`. */
function globRoot(pattern: string): string {
  const cut = pattern.search(/[*?[{]/);
  if (cut === -1) return pattern;
  const head = pattern.slice(0, cut);
  return head.slice(0, head.lastIndexOf('/')) || '/';
}

/** Whether a command's text names a protected file, by any spelling of its path that ends in its name. */
export function commandNamesProtected(command: string, files: readonly string[]): boolean {
  return files.some((file) => {
    const name = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
    return new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.-])`).test(command);
  });
}

/**
 * Why a confined session's tool call is refused, or null. `files` are the protected files, resolved;
 * `resolve` makes a path the call names absolute and real. A search is refused when its folder holds a
 * protected file, so a search of the home folder is too: the agent is told to search a narrower one.
 */
export function protectedRefusal(action: { tool: string; input: Record<string, unknown> }, files: readonly string[], resolve: (path: string) => string, sep = '/'): string | null {
  if (files.length === 0) return null;
  const key = PATH_KEYS[action.tool];
  const value = key ? action.input[key] : undefined;
  if (typeof value === 'string' && value) {
    const target = resolve(value);
    if (files.some((f) => f === target)) return PROTECTED_REFUSAL;
    if (SEARCH_TOOLS.has(action.tool) && files.some((f) => isInside(f, target, sep))) return `${PROTECTED_REFUSAL} Search a narrower folder: ${value} holds it.`;
  }
  if (action.tool === 'Glob' && typeof action.input.pattern === 'string') {
    const pattern = action.input.pattern;
    if (commandNamesProtected(pattern, files)) return PROTECTED_REFUSAL;
    const root = pattern.startsWith('/') ? globRoot(pattern) : null;
    if (root && files.some((f) => isInside(f, resolve(root), sep))) return `${PROTECTED_REFUSAL} Search a narrower folder: ${root} holds it.`;
  }
  for (const k of COMMAND_KEYS) {
    const text = action.input[k];
    if (typeof text === 'string' && commandNamesProtected(text, files)) return PROTECTED_REFUSAL;
  }
  return null;
}
