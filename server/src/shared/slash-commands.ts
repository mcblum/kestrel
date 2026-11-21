// Slash commands: what a session's agent can be asked to do by a message that starts with "/"
// (Claude Code's commands and the user's skills). The agent says what it has; Kestrel keeps the
// list with the session and the message box offers it when "/" is typed. Sending "/name args" as
// the message is all it takes: the agent runs it (checked live on Claude Agent SDK 0.3.322).
// Pure, shared by the server (which keeps the list) and the message box (which filters it).

export interface SlashCommand {
  /** Without the slash: `compact`. */
  name: string;
  description: string;
  /** What it takes after the name, as the agent words it ("<pr number>"); absent when nothing. */
  argumentHint?: string;
}

/** How many commands the menu lists at once; the rest are reached by typing more. */
export const SLASH_MENU_MAX = 50;

/**
 * The agent's list as Kestrel keeps it: the terminal-only ones left out (the agent names those;
 * they act on a terminal that is not there), blanks and repeats dropped, in the agent's order.
 */
export function slashCommandsFrom(listed: readonly unknown[], terminalOnly: readonly string[] = []): SlashCommand[] {
  const hidden = new Set(terminalOnly);
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const raw of listed) {
    const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim().replace(/^\//, '') : '';
    if (!name || /\s/.test(name) || hidden.has(name) || seen.has(name)) continue;
    seen.add(name);
    const hint = typeof c.argumentHint === 'string' ? c.argumentHint.trim() : '';
    out.push({ name, description: typeof c.description === 'string' ? c.description.trim() : '', ...(hint ? { argumentHint: hint } : {}) });
  }
  return out;
}

/**
 * What is being typed as a command name, or null when the message is not one in the making: the
 * text starts with "/" and nothing but the name has been typed yet (no space, no second line).
 * "/" alone is the empty name, which lists everything.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The commands a typed name finds, best first: names that start with it, then names that contain
 * it, then descriptions that mention it; each group in the agent's order. At most `SLASH_MENU_MAX`.
 */
export function matchSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands.slice(0, SLASH_MENU_MAX);
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  const described: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q)) contains.push(c);
    else if (c.description.toLowerCase().includes(q)) described.push(c);
  }
  return [...starts, ...contains, ...described].slice(0, SLASH_MENU_MAX);
}

/** The message box's text once a command is picked: its name and a space, ready for what it takes. */
export const slashCompletion = (command: Pick<SlashCommand, 'name'>): string => `/${command.name} `;
