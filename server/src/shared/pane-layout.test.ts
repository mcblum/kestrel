import { describe, expect, it } from 'vitest';
import { CONTEXT_WIDTH, CONTEXT_WIDTH_LIMITS, contextCardWidth, dragDivider, MAIN_MIN_WIDTH, MAIN_SQUEEZED_WIDTH, NO_PANES, PANE_WIDTH, paneLayout, sanitizeStackSizes, SIM_WIDTH, STACK_MIN_HEIGHT, stackShares, togglePane, type OpenPanes } from './pane-layout.ts';
import { sanitizeSidebar } from './sidebar.ts';

const open = (...panes: (keyof OpenPanes)[]): OpenPanes => panes.reduce<OpenPanes>((o, p) => ({ ...o, [p]: true }), NO_PANES);
const ids = (o: OpenPanes, width = 2400) => paneLayout(o, width).columns.map((c) => c.id);

describe('which columns show', () => {
  it('shows nothing beside the main content when nothing is open', () => {
    expect(paneLayout(NO_PANES, 1440)).toEqual({ columns: [], stack: [], contextFloats: false, mainMin: MAIN_MIN_WIDTH, needed: MAIN_MIN_WIDTH, overflows: false });
  });

  it('gives each pane its own place, in a fixed order whatever was opened first', () => {
    expect(ids(open('context', 'simulator', 'terminal', 'changes'))).toEqual(['context', 'changes', 'tools', 'simulator']);
    expect(ids(open('simulator'))).toEqual(['simulator']);
    expect(ids(open('browser', 'simulator'))).toEqual(['tools', 'simulator']);
    expect(ids(open('changes', 'context'))).toEqual(['context', 'changes']);
  });

  it('stacks files, browser and terminal in one column, the terminal at the bottom', () => {
    expect(paneLayout(open('terminal', 'files', 'browser'), 2400).stack).toEqual(['files', 'browser', 'terminal']);
    expect(paneLayout(open('terminal', 'browser'), 2400).stack).toEqual(['browser', 'terminal']);
    expect(paneLayout(open('agent', 'terminal'), 2400).stack).toEqual(['agent', 'terminal']);
    expect(ids(open('files', 'browser', 'terminal'))).toEqual(['tools']);
  });

  it('turning one pane on or off leaves the others as they were', () => {
    const both = togglePane(togglePane(NO_PANES, 'browser'), 'simulator');
    expect(both.browser && both.simulator).toBe(true);
    expect(togglePane(both, 'browser')).toEqual({ ...NO_PANES, simulator: true });
  });
});

describe('context', () => {
  it('is the first column, nearest the main content, at its fixed width', () => {
    const layout = paneLayout(open('context', 'changes'), 2400);
    expect(layout.contextFloats).toBe(false);
    expect(layout.columns).toEqual([{ id: 'context', width: CONTEXT_WIDTH }, { id: 'changes', width: PANE_WIDTH.initial }]);
  });

  it('stays a column beside any number of others while they all fit', () => {
    for (const panes of [['changes', 'files'], ['browser', 'simulator'], ['changes', 'files', 'simulator']] as const) {
      const layout = paneLayout(open('context', ...panes), 2400);
      expect(layout.contextFloats).toBe(false);
      expect(layout.columns[0]!.id).toBe('context');
    }
  });

  it('floats once it no longer fits as a column, and the others keep their columns', () => {
    // Details and Changes fit side by side at 2400; at the room for Changes at its minimum alone, Details floats.
    const narrow = MAIN_MIN_WIDTH + PANE_WIDTH.min + CONTEXT_WIDTH - 1;
    const layout = paneLayout(open('context', 'changes'), narrow);
    expect(layout.contextFloats).toBe(true);
    expect(layout.columns).toEqual([{ id: 'changes', width: PANE_WIDTH.initial }]);
    expect(layout.overflows).toBe(false);
  });

  it('the others give way before it floats', () => {
    const room = MAIN_MIN_WIDTH + CONTEXT_WIDTH + PANE_WIDTH.min;
    const layout = paneLayout(open('context', 'changes'), room);
    expect(layout.contextFloats).toBe(false);
    expect(layout.columns).toEqual([{ id: 'context', width: CONTEXT_WIDTH }, { id: 'changes', width: PANE_WIDTH.min }]);
  });

  it('alone in a window too narrow for it as a column, it floats, so the main content keeps its width', () => {
    const layout = paneLayout(open('context'), MAIN_MIN_WIDTH + CONTEXT_WIDTH - 1);
    expect(layout).toMatchObject({ columns: [], contextFloats: true, overflows: false });
    expect(paneLayout(open('context'), MAIN_MIN_WIDTH + CONTEXT_WIDTH)).toMatchObject({ columns: [{ id: 'context', width: CONTEXT_WIDTH }], contextFloats: false });
  });
});

describe('widths', () => {
  it('uses the dragged widths, held inside each column\'s limits', () => {
    const layout = paneLayout(open('changes', 'files', 'simulator'), 4000, { changes: 500, tools: 10, simulator: 5000 });
    expect(layout.columns).toEqual([
      { id: 'changes', width: 500 },
      { id: 'tools', width: PANE_WIDTH.min },
      { id: 'simulator', width: SIM_WIDTH.max },
    ]);
  });

  it('starts the simulator about a phone wide', () => {
    expect(paneLayout(open('simulator'), 1440).columns).toEqual([{ id: 'simulator', width: SIM_WIDTH.initial }]);
  });

  it('never lets one column run past the window, however wide it was dragged', () => {
    const layout = paneLayout(open('files'), 1440, { tools: PANE_WIDTH.max });
    expect(layout.columns[0]!.width).toBe(1440 - MAIN_MIN_WIDTH);
    expect(layout.overflows).toBe(false);
  });

  it('lets the pane area scroll only when every column is at its minimum and the main content is squeezed to its least', () => {
    const layout = paneLayout(open('changes', 'files', 'simulator', 'context'), 1100);
    expect(layout.columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, PANE_WIDTH.min, SIM_WIDTH.min]);
    expect(layout.mainMin).toBe(MAIN_SQUEEZED_WIDTH);
    expect(layout.needed).toBe(MAIN_SQUEEZED_WIDTH + 2 * PANE_WIDTH.min + SIM_WIDTH.min);
    expect(layout.overflows).toBe(true);
  });

  it('keeps the main content at its minimum while the columns fit beside it', () => {
    expect(paneLayout(open('files', 'simulator'), MAIN_MIN_WIDTH + PANE_WIDTH.min + SIM_WIDTH.min).mainMin).toBe(MAIN_MIN_WIDTH);
    expect(paneLayout(NO_PANES, 400).mainMin).toBe(MAIN_MIN_WIDTH);
  });

  it('squeezes the main content before the columns run past the window: the tools column and the Simulator fit a 900px window on the rail', () => {
    // 900px window, less the 48px rail: Files, Terminal, Browser and the Simulator.
    const layout = paneLayout(open('files', 'terminal', 'browser', 'simulator'), 852);
    expect(layout.columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, SIM_WIDTH.min]);
    expect(layout.mainMin).toBe(852 - PANE_WIDTH.min - SIM_WIDTH.min);
    expect(layout.overflows).toBe(false);
  });

  it('narrows Changes first, then the tools column, then the Simulator, before anything scrolls', () => {
    const all = open('changes', 'files', 'browser', 'terminal', 'simulator');
    const total = (room: number) => paneLayout(all, room).columns.reduce((sum, c) => sum + c.width, 0);
    // Room for everything but 100px: only Changes gives way.
    const roomy = MAIN_MIN_WIDTH + 2 * PANE_WIDTH.initial + SIM_WIDTH.initial - 100;
    expect(paneLayout(all, roomy).columns.map((c) => c.width)).toEqual([PANE_WIDTH.initial - 100, PANE_WIDTH.initial, SIM_WIDTH.initial]);
    expect(paneLayout(all, roomy).overflows).toBe(false);
    // Changes at its minimum, the tools column takes the rest.
    const tight = MAIN_MIN_WIDTH + PANE_WIDTH.min + PANE_WIDTH.initial + SIM_WIDTH.initial - 50;
    expect(paneLayout(all, tight).columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, PANE_WIDTH.initial - 50, SIM_WIDTH.initial]);
    // Both at their minimum, the Simulator gives way last.
    const tighter = MAIN_MIN_WIDTH + 2 * PANE_WIDTH.min + SIM_WIDTH.initial - 40;
    expect(paneLayout(all, tighter).columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, PANE_WIDTH.min, SIM_WIDTH.initial - 40]);
    for (const room of [roomy, tight, tighter]) expect(total(room)).toBe(room - MAIN_MIN_WIDTH);
  });

  it('fits a 1440px window with a sidebar and every pane open, the tools column on screen', () => {
    const layout = paneLayout(open('changes', 'files', 'browser', 'terminal', 'simulator', 'context'), 1440 - 252);
    const tools = layout.columns.find((c) => c.id === 'tools')!;
    const left = MAIN_MIN_WIDTH + layout.columns[0]!.width;
    expect(layout.columns[0]).toEqual({ id: 'changes', width: PANE_WIDTH.min });
    expect(left + tools.width).toBeLessThanOrEqual(1440 - 252);
  });

  it('gives way without touching the widths the user dragged to, which apply again with room', () => {
    const widths = { changes: 600, tools: 500, simulator: 400 };
    const panes = open('changes', 'files', 'simulator');
    // 50px short once Changes is at its minimum: the tools column gives the 50px.
    const room = MAIN_MIN_WIDTH + PANE_WIDTH.min + 500 + 400 - 50;
    expect(paneLayout(panes, room, widths).columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, 450, 400]);
    expect(widths).toEqual({ changes: 600, tools: 500, simulator: 400 });
    expect(paneLayout(panes, 2400, widths).columns.map((c) => c.width)).toEqual([600, 500, 400]);
  });

  it('never narrows the Context column', () => {
    const layout = paneLayout(open('changes', 'context'), MAIN_MIN_WIDTH + PANE_WIDTH.initial + CONTEXT_WIDTH - 100);
    expect(layout.columns).toEqual([{ id: 'context', width: CONTEXT_WIDTH }, { id: 'changes', width: PANE_WIDTH.initial - 100 }]);
  });

  it('never makes a column narrower than its minimum, even in a tiny window', () => {
    const layout = paneLayout(open('files', 'simulator'), 500);
    expect(layout.columns.map((c) => c.width)).toEqual([PANE_WIDTH.min, SIM_WIDTH.min]);
    expect(layout.overflows).toBe(true);
  });

  it('fits exactly when there is room', () => {
    const layout = paneLayout(open('browser'), MAIN_MIN_WIDTH + PANE_WIDTH.initial);
    expect(layout.overflows).toBe(false);
  });

  it('ignores widths that are not numbers', () => {
    expect(paneLayout(open('files'), 2400, { tools: Number.NaN }).columns[0]!.width).toBe(PANE_WIDTH.initial);
  });
});

describe('stacked heights', () => {
  it('shares the column evenly until a divider is dragged', () => {
    expect(stackShares(['files', 'browser', 'terminal'])).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('moves only the two panes beside a dragged divider', () => {
    const stack = ['files', 'browser', 'terminal'] as const;
    const next = dragDivider(stack, {}, 0, 60, 600);
    const shares = stackShares(stack, next).map((s) => Math.round(s * 600));
    expect(shares).toEqual([260, 140, 200]);
  });

  it('never squeezes a pane below the minimum height', () => {
    const stack = ['browser', 'terminal'] as const;
    const shares = stackShares(stack, dragDivider(stack, {}, 0, 5000, 600)).map((s) => Math.round(s * 600));
    expect(shares).toEqual([600 - STACK_MIN_HEIGHT, STACK_MIN_HEIGHT]);
  });

  it('ignores a divider that does not exist', () => {
    const weights = { files: 2 };
    expect(dragDivider(['files'], weights, 0, 50, 400)).toBe(weights);
  });
});

describe('stored sizes', () => {
  it('keeps the simulator width and stack heights, sanitized', () => {
    const prefs = sanitizeSidebar({ order: [], collapsed: [], simWidth: 99999, stack: { session: { files: 2, terminal: -1, bogus: 3 }, project: 'nope', planet: { files: 1 } } });
    expect(prefs.simWidth).toBe(SIM_WIDTH.max);
    expect(prefs.stack).toEqual({ session: { files: 2 } });
  });

  it('loads prefs stored before the simulator column and stacking existed', () => {
    const prefs = sanitizeSidebar({ order: ['a'], collapsed: [], paneWidth: 500, changesWidth: 400 });
    expect(prefs).toEqual({ order: ['a'], collapsed: [], paneWidth: 500, changesWidth: 400 });
  });

  it('drops stack sizes that hold nothing usable', () => {
    expect(sanitizeStackSizes({ group: { files: 'big' } })).toBeUndefined();
    expect(sanitizeStackSizes(null)).toBeUndefined();
    expect(sanitizeStackSizes({ group: { browser: 1e9 } })).toEqual({ group: { browser: 20 } });
  });

  it('gives the Details pane the width it was dragged to, inside its limits, as a column and as a card', () => {
    const open = { ...NO_PANES, context: true };
    expect(paneLayout(open, 1400, { context: 400 }).columns).toEqual([{ id: 'context', width: 400 }]);
    expect(paneLayout(open, 1400, { context: 5000 }).columns).toEqual([{ id: 'context', width: CONTEXT_WIDTH_LIMITS.max }]);
    expect(paneLayout(open, 1400).columns).toEqual([{ id: 'context', width: CONTEXT_WIDTH_LIMITS.initial }]);
    expect(contextCardWidth(undefined)).toBe(CONTEXT_WIDTH_LIMITS.initial);
    expect(contextCardWidth(100)).toBe(CONTEXT_WIDTH_LIMITS.min);
    expect(contextCardWidth(380)).toBe(380);
  });
});
