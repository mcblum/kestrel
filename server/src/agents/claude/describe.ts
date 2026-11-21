// Plain-language descriptions of Claude tool calls, for the activity list and approval cards.
import { relative, isAbsolute } from 'node:path';

type Input = Record<string, unknown>;

const MAX_LINE = 140;
const MAX_DETAIL = 4000;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function str(input: Input, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** Show a path relative to the session's directory when it is inside it. */
export function shortPath(path: string, cwd: string): string {
  if (!path || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** The file an edit tool writes, as the agent named it; none for any other tool. */
export function editedFile(tool: string, input: Record<string, unknown>): string[] {
  if (!FILE_TOOLS.has(tool)) return [];
  const path = input.file_path ?? input.notebook_path;
  return typeof path === 'string' ? [path] : [];
}

/** Tools after which files may have changed. Bash can change anything. */
export function mayChangeFiles(tool: string): boolean {
  return FILE_TOOLS.has(tool) || tool === 'Bash';
}

/** The name of an element the agent read in the browser pane, by its ref, when Kestrel knows it. */
export type ElementLookup = (ref: number) => string | null;

const refText = (input: Input) => (typeof input.ref === 'number' || typeof input.ref === 'string' ? String(input.ref) : '?');
/** `“Sign in”` when the element's name is known from the last read, else `element 3`. */
function elementText(input: Input, element?: ElementLookup): string {
  const ref = typeof input.ref === 'number' ? input.ref : Number(input.ref);
  const name = Number.isSafeInteger(ref) ? element?.(ref) : null;
  return name ? `“${clip(name, 60)}”` : `element ${refText(input)}`;
}

const num = (input: Input, key: string) => (typeof input[key] === 'number' && Number.isFinite(input[key]) ? String(Math.round((input[key] as number) * 10) / 10) : '?');
const BUTTON_NAME: Record<string, string> = { home: 'Home', lock: 'Lock', siri: 'Siri', volume_up: 'Volume up', volume_down: 'Volume down' };
const MODIFIER_SIGN: Record<string, string> = { control: '⌃', option: '⌥', shift: '⇧', command: '⌘' };
/** "⇧⌘Z" for {key: "z", modifiers: ["command", "shift"]}, "Return" for {key: "return"}. */
function keyCombo(input: Input): string {
  const key = str(input, 'key');
  const name = key.length === 1 ? key.toUpperCase() : key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const held = Array.isArray(input.modifiers) ? ['control', 'option', 'shift', 'command'].filter((m) => (input.modifiers as unknown[]).includes(m)) : [];
  return `${held.map((m) => MODIFIER_SIGN[m]).join('')}${name || 'a key'}`;
}
/** "Wren.app" for an app path, else the bundle id. */
function appName(input: Input): string {
  const path = str(input, 'app_path').replace(/\/+$/, '');
  return path ? path.split('/').pop() || path : str(input, 'bundle_id') || 'an app';
}

export function summarizeTool(name: string, input: Input, cwd: string, element?: ElementLookup): string {
  switch (name) {
    case 'Write':
      return `Write ${shortPath(str(input, 'file_path'), cwd)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${shortPath(str(input, 'file_path'), cwd)}`;
    case 'Read':
      return `Read ${shortPath(str(input, 'file_path'), cwd)}`;
    case 'Bash':
      return clip(`Run ${str(input, 'command').split('\n')[0]}`, MAX_LINE);
    case 'Glob':
    case 'Grep':
      return `${name} ${str(input, 'pattern')}`;
    case 'ToolSearch':
      return 'Load a tool';
    case 'Agent':
    case 'Task':
      return clip(str(input, 'description') || 'Sub-agent', MAX_LINE);
    case 'mcp__kestrel__browser_navigate':
      return clip(`Open ${str(input, 'url') || 'a page'} in the browser`, MAX_LINE);
    case 'mcp__kestrel__browser_read':
      return 'Read the page in the browser';
    case 'mcp__kestrel__browser_click':
      return `Click ${elementText(input, element)}`;
    case 'mcp__kestrel__browser_type':
      return `Type into ${elementText(input, element)}`;
    case 'mcp__kestrel__browser_screenshot':
      return 'Take a screenshot of the browser';
    case 'mcp__kestrel__browser_console':
      return "Read the browser's console";
    case 'mcp__kestrel__sim_list':
      return 'List the simulators';
    case 'mcp__kestrel__sim_boot':
      return clip(`Boot ${str(input, 'device') || 'a simulator'}`, MAX_LINE);
    case 'mcp__kestrel__sim_launch':
      return clip(`Launch ${appName(input)} in the simulator`, MAX_LINE);
    case 'mcp__kestrel__sim_screenshot':
      return 'Take a screenshot of the simulator';
    case 'mcp__kestrel__sim_tap':
      return `${typeof input.duration_ms === 'number' && input.duration_ms >= 500 ? 'Long-press' : 'Tap'} at ${num(input, 'x')}, ${num(input, 'y')}`;
    case 'mcp__kestrel__sim_swipe':
      return `Swipe from ${num(input, 'x1')}, ${num(input, 'y1')} to ${num(input, 'x2')}, ${num(input, 'y2')}`;
    case 'mcp__kestrel__sim_pinch':
      return `Pinch at ${num(input, 'x')}, ${num(input, 'y')} to ${num(input, 'scale')}×${typeof input.rotation_deg === 'number' && input.rotation_deg !== 0 ? `, turning ${num(input, 'rotation_deg')}°` : ''}`;
    case 'mcp__kestrel__sim_type':
      return 'Type into the simulator';
    case 'mcp__kestrel__sim_key':
      return `Press ${keyCombo(input)} in the simulator`;
    case 'mcp__kestrel__sim_button':
      return str(input, 'button') === 'shake' ? 'Shake the simulator' : `Press ${BUTTON_NAME[str(input, 'button')] ?? 'a button'} in the simulator`;
    case 'mcp__kestrel__sim_open_url':
      return clip(`Open ${str(input, 'url') || 'a URL'} in the simulator`, MAX_LINE);
    case 'mcp__kestrel__sim_appearance':
      return `Switch the simulator to ${str(input, 'mode') === 'dark' ? 'dark' : 'light'} mode`;
    default:
      return name.startsWith('mcp__kestrel__') ? `Kestrel: ${name.slice('mcp__kestrel__'.length)}` : name;
  }
}

/** What an approval card shows: a title and exactly what would run or be written. */
export function describeApproval(name: string, input: Input, cwd: string, element?: ElementLookup): { title: string; detail: string } {
  switch (name) {
    case 'Write':
      return { title: `Write ${shortPath(str(input, 'file_path'), cwd)}`, detail: clip(str(input, 'content'), MAX_DETAIL) };
    case 'Edit':
      return { title: `Edit ${shortPath(str(input, 'file_path'), cwd)}`, detail: clip(`- ${str(input, 'old_string')}\n+ ${str(input, 'new_string')}`, MAX_DETAIL) };
    case 'Bash':
      return { title: 'Run a command', detail: clip([str(input, 'description'), str(input, 'command')].filter(Boolean).join('\n\n'), MAX_DETAIL) };
    case 'mcp__kestrel__browser_navigate':
      return { title: summarizeTool(name, input, cwd), detail: clip(str(input, 'url'), MAX_DETAIL) };
    case 'mcp__kestrel__browser_click':
      return { title: summarizeTool(name, input, cwd, element), detail: `Element ${refText(input)} of the page in the browser pane, as the agent last read it.` };
    case 'mcp__kestrel__browser_type':
      return { title: summarizeTool(name, input, cwd, element), detail: clip(`${str(input, 'text')}${input.submit === true ? '\n\nThen submit the form.' : ''}`, MAX_DETAIL) };
    case 'mcp__kestrel__sim_launch':
      return { title: summarizeTool(name, input, cwd), detail: str(input, 'app_path') ? `Install and launch ${shortPath(str(input, 'app_path'), cwd)} on the session's simulator.` : `Launch ${str(input, 'bundle_id')} on the session's simulator.` };
    case 'mcp__kestrel__sim_tap':
    case 'mcp__kestrel__sim_swipe':
    case 'mcp__kestrel__sim_pinch':
      return { title: summarizeTool(name, input, cwd), detail: 'Device points on the simulator screen as shown in the Simulator view, origin top-left.' };
    case 'mcp__kestrel__sim_key':
      return { title: summarizeTool(name, input, cwd), detail: 'A key press on the simulator\'s keyboard, into whatever has focus there.' };
    case 'mcp__kestrel__sim_type':
      return { title: summarizeTool(name, input, cwd), detail: clip(str(input, 'text'), MAX_DETAIL) };
    case 'mcp__kestrel__sim_boot':
    case 'mcp__kestrel__sim_button':
    case 'mcp__kestrel__sim_open_url':
      return { title: summarizeTool(name, input, cwd), detail: clip(str(input, 'url') || str(input, 'device') || str(input, 'button'), MAX_DETAIL) };
    default:
      return { title: summarizeTool(name, input, cwd), detail: clip(JSON.stringify(input, null, 2), MAX_DETAIL) };
  }
}
