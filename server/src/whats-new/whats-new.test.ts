// What's new (docs/designs/kestrel.md, "What's new"): which notes a version shows, the one record of
// what was shown, and when the notes open by themselves: after an update only, never on a first
// install, never twice for the same file, and for a beta again only when its notes changed.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppPage, parseViewPath, SETTINGS_PAGES, SETTINGS_SECTIONS, viewPath } from '../shared/routes.ts';
import { openBeside, type TabsState } from '../shared/tabs.ts';
import { appLinksIn, hostNotes, isDue, parseNotes, releaseOf, whatsNewPath, withoutAppLinks } from '../shared/whats-new.ts';
import { notesTakeFront } from '../shared/whats-new-focus.ts';
import { NOTES_ENTRY_MAX, notesFormatProblems, notesLayout } from '../shared/whats-new-layout.ts';
import { sanitizeSvg } from '../shared/whats-new-svg.ts';
import { memorySettings } from '../suggestions/prefs.ts';
import { whatsNewRoute } from './api.ts';
import { notesSource } from './notes.ts';
import { WHATS_NEW_KEY, WhatsNew } from './store.ts';

const NOTES = '# Kestrel 0.0.32\n\n## Kestrel on your iPhone\n\nSessions on a phone.\n';

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-whats-new-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function setup(opts: { files?: Record<string, string>; version?: string; packaged?: boolean; stored?: Record<string, string> } = {}) {
  const dir = folder(opts.files ?? { '0.0.32.md': NOTES, '0.0.31.md': '# Kestrel 0.0.31\n\nOlder.\n' });
  const settings = memorySettings();
  for (const [k, v] of Object.entries(opts.stored ?? { 'ui-state': '{}' })) void settings.putSetting(k, v);
  const notes = notesSource(dir);
  const make = () => new WhatsNew({ settings, notes, version: opts.version ?? '0.0.32', packaged: opts.packaged ?? true });
  return { dir, settings, notes, make };
}

describe('which notes a version shows', () => {
  it('a release shows its own; a beta the release it is a beta of', () => {
    expect(releaseOf('0.0.32')).toBe('0.0.32');
    expect(releaseOf('0.0.32-beta.7')).toBe('0.0.32');
    expect(releaseOf('0.0.32-rc.1')).toBeNull();
    expect(releaseOf('')).toBeNull();
  });

  it('a notes file is a title line and something under it', () => {
    expect(parseNotes(NOTES)).toEqual({ title: 'Kestrel 0.0.32', body: '## Kestrel on your iPhone\n\nSessions on a phone.' });
    expect(parseNotes('')).toEqual({ error: 'it is empty' });
    expect(parseNotes('Kestrel 0.0.32\n\ntext')).toHaveProperty('error');
    expect(parseNotes('# Kestrel 0.0.32\n\n')).toHaveProperty('error');
  });

  it('the host gets the body without its pictures', () => {
    const parsed = parseNotes('# T\n\nOne.\n\n![The pane](images/pane.png)\n\nTwo.\n');
    expect('error' in parsed ? null : hostNotes(parsed)).toBe('One.\n\nTwo.');
  });

  it('lists every release with notes, newest first, numbers compared as numbers', async () => {
    const { notes } = setup({ files: { '0.0.9.md': '# Nine\n\nx', '0.0.32.md': NOTES, 'README.md': '# not notes\n\nx', '0.0.10.md': 'no title' } });
    expect(await notes.list()).toEqual([
      { release: '0.0.32', title: 'Kestrel 0.0.32' },
      { release: '0.0.9', title: 'Nine' },
    ]);
  });

  it('no folder at all is no notes, not a failure', async () => {
    const notes = notesSource(join(tmpdir(), 'kestrel-no-such-folder-whats-new'));
    expect(await notes.list()).toEqual([]);
    expect(await notes.read('0.0.32')).toBeNull();
  });
});

describe('when the notes open by themselves', () => {
  it('after an update from a copy that was used before: due, once', async () => {
    const s = setup();
    const view = await s.make().view();
    expect(view.release).toBe('0.0.32');
    expect(view.due?.release).toBe('0.0.32');
    expect(view.releases.map((r) => r.release)).toEqual(['0.0.32', '0.0.31']);
  });

  it('never on a first install: what it carries counts as shown', async () => {
    const s = setup({ stored: {} });
    expect((await s.make().view()).due).toBeNull();
    expect(JSON.parse((await s.settings.getSetting(WHATS_NEW_KEY))!).shown.release).toBe('0.0.32');
    // Nor on the next start.
    expect((await s.make().view()).due).toBeNull();
  });

  it('never twice for the same notes: shown is kept by the server, across starts', async () => {
    const s = setup();
    const first = s.make();
    const due = (await first.view()).due!;
    const pushed: unknown[] = [];
    first.onChange((v) => pushed.push(v.due));
    expect((await first.markShown(due)).due).toBeNull();
    expect(pushed).toEqual([null]);
    expect((await s.make().view()).due).toBeNull();
  });

  it('a beta whose notes did not change opens nothing; one whose notes grew opens them again', async () => {
    const s = setup({ version: '0.0.32-beta.6' });
    const shown = (await s.make().view()).due!;
    await s.make().markShown(shown);
    // beta.7, the same file.
    expect((await new WhatsNew({ settings: s.settings, notes: s.notes, version: '0.0.32-beta.7', packaged: true }).view()).due).toBeNull();
    // beta.8, the notes grew.
    writeFileSync(join(s.dir, '0.0.32.md'), `${NOTES}\n## Autopilot\n\nMore.\n`);
    const grown = await new WhatsNew({ settings: s.settings, notes: s.notes, version: '0.0.32-beta.8', packaged: true }).view();
    expect(grown.due?.release).toBe('0.0.32');
    expect(grown.due?.hash).not.toBe(shown.hash);
  });

  it('a beta with no notes file opens nothing', async () => {
    const s = setup({ version: '0.0.33-beta.1' });
    expect((await s.make().view()).due).toBeNull();
  });

  it('a checkout never opens them by itself, and stores nothing', async () => {
    const s = setup({ packaged: false });
    expect((await s.make().view()).due).toBeNull();
    expect(await s.settings.getSetting(WHATS_NEW_KEY)).toBeNull();
  });

  it('with the switch off nothing opens, and turning it on later does not bring old notes back', async () => {
    const s = setup();
    const store = s.make();
    await store.setEnabled(false);
    expect((await store.view()).due).toBeNull();
    const next = s.make();
    expect((await next.view()).enabled).toBe(false);
    expect((await next.setEnabled(true)).due).toBeNull();
  });

  it('the rule itself, in one place', () => {
    const notes = { release: '0.0.32', hash: 'a'.repeat(32) };
    const record = { shown: null, enabled: true };
    expect(isDue({ packaged: true, record, notes })).toBe(true);
    expect(isDue({ packaged: false, record, notes })).toBe(false);
    expect(isDue({ packaged: true, record: { ...record, enabled: false }, notes })).toBe(false);
    expect(isDue({ packaged: true, record, notes: null })).toBe(false);
    expect(isDue({ packaged: true, record: { shown: notes, enabled: true }, notes })).toBe(false);
    expect(isDue({ packaged: true, record: { shown: { ...notes, release: '0.0.31' }, enabled: true }, notes })).toBe(true);
  });
});

describe('the routes', () => {
  const ask = async (s: ReturnType<typeof setup>, store: WhatsNew, path: string, method = 'GET', body: Record<string, unknown> = {}) => whatsNewRoute(path.split('/').filter(Boolean), method, async () => body, store, s.notes);

  it('gives a release by route, and refuses one it has not', async () => {
    const s = setup();
    const store = s.make();
    expect(await ask(s, store, '/api/whats-new/notes/0.0.31')).toMatchObject({ status: 200, body: { release: '0.0.31', title: 'Kestrel 0.0.31', body: 'Older.' } });
    expect(await ask(s, store, '/api/whats-new/notes/0.0.30')).toMatchObject({ status: 404 });
    expect(await ask(s, store, '/api/whats-new/notes/..%2Fsecret')).toMatchObject({ status: 404 });
  });

  it('marks shown only notes this copy really has', async () => {
    const s = setup();
    const store = s.make();
    const due = (await store.view()).due!;
    expect(await ask(s, store, '/api/whats-new/shown', 'POST', { release: '0.0.32', hash: 'f'.repeat(32) })).toMatchObject({ status: 400 });
    expect(await ask(s, store, '/api/whats-new/shown', 'POST', { ...due })).toMatchObject({ status: 200, body: { due: null } });
  });

  it('the switch takes true or false only', async () => {
    const s = setup();
    const store = s.make();
    expect(await ask(s, store, '/api/whats-new', 'PATCH', { enabled: 'no' })).toMatchObject({ status: 400 });
    expect(await ask(s, store, '/api/whats-new', 'PATCH', { enabled: false })).toMatchObject({ status: 200, body: { enabled: false } });
  });

  it('serves a picture from the notes folder by a plain name only', async () => {
    const s = setup({ files: { '0.0.32.md': NOTES, 'images/pane.png': 'png' } });
    const store = s.make();
    expect(await ask(s, store, '/api/whats-new/images/pane.png')).toMatchObject({ status: 200, type: 'image/png' });
    expect(await ask(s, store, '/api/whats-new/images/..%2F0.0.32.md')).toMatchObject({ status: 404 });
    expect(await ask(s, store, '/api/whats-new/images/none.png')).toMatchObject({ status: 404 });
  });

  it('serves a drawing only as sanitized markup, never as an SVG document', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script>x</script><path d="M0 0"/></svg>';
    const s = setup({ files: { '0.0.32.md': NOTES, 'images/two.svg': svg, 'images/bad.svg': '<html></html>' } });
    const store = s.make();
    expect(await ask(s, store, '/api/whats-new/drawings/two.svg')).toEqual({ status: 200, body: { name: 'two.svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><path d="M0 0"/></svg>' } });
    expect(await ask(s, store, '/api/whats-new/images/two.svg')).toMatchObject({ status: 404 });
    expect(await ask(s, store, '/api/whats-new/drawings/bad.svg')).toMatchObject({ status: 404, body: { error: 'bad.svg is not a plain SVG drawing, so it is not shown.' } });
    expect(await ask(s, store, '/api/whats-new/drawings/none.svg')).toMatchObject({ status: 404 });
    expect(await ask(s, store, '/api/whats-new/drawings/..%2F0.0.32.md')).toMatchObject({ status: 404 });
  });
});

describe('where the notes open after an update', () => {
  const state: TabsState = { tabs: [{ id: 'a', kind: 'page', path: '#/' }, { id: 'b', kind: 'session', sessionId: 's1' }, { id: 'c', kind: 'page', path: '#/settings' }], activeId: 'b' };

  it('in a new tab just after the tab in front, which keeps its place', () => {
    const next = openBeside(state, whatsNewPath(), 'n', { focus: true });
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'b', 'n', 'c']);
    expect(next.activeId).toBe('n');
    expect(openBeside(state, whatsNewPath(), 'n', { focus: false }).activeId).toBe('b');
  });

  it('never a second time when a tab already shows them: that tab comes to the front instead', () => {
    const once = openBeside(state, whatsNewPath(), 'n', { focus: true });
    expect(openBeside(once, whatsNewPath(), 'm', { focus: true })).toBe(once);
    const behind = { ...once, activeId: 'a' };
    expect(openBeside(behind, whatsNewPath(), 'm', { focus: true })).toEqual({ ...once, activeId: 'n' });
    expect(openBeside(behind, whatsNewPath(), 'm', { focus: false })).toBe(behind);
  });

  it('a link clicked on What\'s new opens beside it, in front, and the notes keep their tab', () => {
    const onNotes = openBeside(state, whatsNewPath(), 'n', { focus: true });
    const next = openBeside(onNotes, '#/settings/git', 'g', { focus: true });
    expect(next.tabs.map((t) => t.id)).toEqual(['a', 'b', 'n', 'g', 'c']);
    expect(next.activeId).toBe('g');
  });

  it('to the front, unless the tab in front is a session waiting on the user', () => {
    const sessions = [
      { id: 'idle', state: 'done' as const, note: '' },
      { id: 'asks', state: 'attention' as const, note: 'Needs you · an approval' },
      { id: 'broke', state: 'attention' as const, note: 'Failed · it stopped' },
    ];
    const front = (sessionId: string) => ({ id: 't', kind: 'session' as const, sessionId });
    expect(notesTakeFront({ id: 'o', kind: 'page', path: '#/' }, sessions)).toBe(true);
    expect(notesTakeFront(undefined, sessions)).toBe(true);
    expect(notesTakeFront(front('idle'), sessions)).toBe(true);
    expect(notesTakeFront(front('asks'), sessions)).toBe(false);
    expect(notesTakeFront(front('broke'), sessions)).toBe(false);
  });

  it('the page has a route of its own, for the current notes and an older release', () => {
    expect(parseViewPath(whatsNewPath())).toEqual({ kind: 'whats-new' });
    expect(parseViewPath(whatsNewPath('0.0.31'))).toEqual({ kind: 'whats-new', release: '0.0.31' });
    expect(viewPath({ kind: 'whats-new', release: '0.0.31' })).toBe('#/whats-new/0.0.31');
    expect(viewPath({ kind: 'whats-new' })).toBe(whatsNewPath());
    expect(parseViewPath('#/whats-new/nope')).toEqual({ kind: 'whats-new' });
  });
});

describe('links to a place in the app', () => {
  it('the host copy drops a line or sentence that is only such a link', () => {
    expect(withoutAppLinks('Autopilot sees it through.\n\n[Open Settings → Git](#/settings/git)\n\nNext.')).toBe('Autopilot sees it through.\n\nNext.');
    expect(withoutAppLinks('- [Open Code reviews](#/code-reviews).\n- Other.')).toBe('- Other.');
    expect(withoutAppLinks('It merges when green. [Open Settings → Git](#/settings/git).')).toBe('It merges when green.');
    expect(withoutAppLinks('It merges. [Open Settings → Git](#/settings/git). Then it stops.')).toBe('It merges. Then it stops.');
  });

  it('a link inside a sentence becomes its plain text', () => {
    expect(withoutAppLinks('Choose which count in [Settings → Git](#/settings/git), on by default.')).toBe('Choose which count in Settings → Git, on by default.');
  });

  it('nothing else is changed: links out of the app, pictures, code, spacing', () => {
    const text = '## Title\n\nSee [the docs](https://kestrelapp.ai/docs/).  Two spaces stay.\n\n![A picture](images/a.png)\n\n`#/settings` in code.';
    expect(withoutAppLinks(text)).toBe(text);
  });

  it('the host notes take out both pictures and in-app links', () => {
    const parsed = parseNotes('# T\n\nOne, in [Settings](#/settings).\n\n[Open Settings → Git](#/settings/git)\n\n![P](images/p.png)\n\nTwo.');
    expect('error' in parsed ? null : hostNotes(parsed)).toBe('One, in Settings.\n\nTwo.');
  });

  it('a page the app has, the same for everyone, is a place a note may link to', () => {
    for (const section of SETTINGS_SECTIONS) expect(isAppPage(`#/settings/${section}`), section).toBe(true);
    for (const page of SETTINGS_PAGES) expect(isAppPage(`#/settings/${page}`), page).toBe(true);
    for (const path of ['#/', '#/settings', '#/code-reviews', '#/tickets', '#/pull-requests', '#/whats-new', '#/whats-new/0.0.31', '#/attention']) expect(isAppPage(path), path).toBe(true);
    for (const path of ['#/settings/nope', '#/nope', '#/project/abc', '#/tag/x', '#/settings/git/extra', 'settings/git', '#settings']) expect(isAppPage(path), path).toBe(false);
  });

  it('every notes file in the repository links only to pages the app has', () => {
    const dir = new URL('../../../whats-new/', import.meta.url);
    const files = readdirSync(dir).filter((n) => n.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(new URL(name, dir), 'utf8');
      expect('error' in parseNotes(text), `${name} is not a notes file`).toBe(false);
      for (const link of appLinksIn(text)) expect(isAppPage(link), `${name} links to ${link}, which the app does not have`).toBe(true);
    }
  });
});

const STRUCTURED = [
  '## Kestrel Connect',
  '',
  '### See your sessions from any computer.',
  '',
  'Only your devices can read your conversations.',
  '',
  '[Open Connections](#/settings/connections)',
  '',
  '![End-to-end encrypted](images/connect-devices.svg)',
  '',
  '## Also in this release',
  '',
  '### MCP servers',
  '',
  'Add a server once and every session gets it.',
  '',
  '[Open MCP servers](#/settings/agent-setup)',
  '',
  '### Autopilot',
  '',
  'Sees a pull request through.',
  '',
  '## More changes',
  '',
  '### Changes pane',
  '',
  'The list and the diff **scroll** on their own.',
  '',
].join('\n');

describe('how the notes are laid out', () => {
  it('reads the spotlight, its action and picture, and the entries of both sections', () => {
    const layout = notesLayout(STRUCTURED);
    expect(layout).toEqual({
      kind: 'structured',
      spotlight: {
        label: 'Kestrel Connect',
        title: 'See your sessions from any computer.',
        body: 'Only your devices can read your conversations.',
        action: { label: 'Open Connections', href: '#/settings/connections' },
        picture: { src: 'images/connect-devices.svg', alt: 'End-to-end encrypted' },
      },
      also: [
        { title: 'MCP servers', body: 'Add a server once and every session gets it.', action: { label: 'Open MCP servers', href: '#/settings/agent-setup' }, picture: null },
        { title: 'Autopilot', body: 'Sees a pull request through.', action: null, picture: null },
      ],
      more: [{ title: 'Changes pane', body: 'The list and the diff **scroll** on their own.', action: null, picture: null }],
    });
  });

  it('the spotlight and More changes are optional', () => {
    const layout = notesLayout('## Also in this release\n\n### A\n\nText.\n');
    expect(layout).toMatchObject({ kind: 'structured', spotlight: null, more: [] });
  });

  it('anything else is plain: other sections, text before the first, a section out of order, text before an entry', () => {
    for (const body of [
      '## Autopilot\n\nText.\n',
      'Intro.\n\n## Also in this release\n\n### A\n\nText.\n',
      '## More changes\n\n### A\n\nB.\n\n## Also in this release\n\n### C\n\nD.\n',
      '## Also in this release\n\nLoose text.\n\n### A\n\nB.\n',
      '## Also in this release\n\n### A\n\nB.\n\n## Something else\n\nC.\n',
      '## Connect\n\nNo headline.\n\n## Also in this release\n\n### A\n\nB.\n',
    ])
      expect(notesLayout(body).kind, body).toBe('plain');
  });

  it('a heading-like line inside a code fence starts nothing', () => {
    const layout = notesLayout('## Also in this release\n\n### A\n\n```\n## More changes\n```\n');
    expect(layout).toMatchObject({ kind: 'structured', also: [{ title: 'A', body: '```\n## More changes\n```' }], more: [] });
  });
});

describe('the shape of a notes file', () => {
  it('a structured file is checked per entry, the spotlight included', () => {
    expect(notesFormatProblems(STRUCTURED)).toEqual([]);
    const long = STRUCTURED.replace('Sees a pull request through.', 'word '.repeat(45).trim());
    expect(notesFormatProblems(long)).toEqual([expect.stringMatching(new RegExp(`^“Autopilot” \\(Also in this release\\) is \\d+ characters: at most ${NOTES_ENTRY_MAX}`))]);
    const twoLinks = STRUCTURED.replace('Only your devices', 'Only [your devices](#/settings/connections)');
    expect(notesFormatProblems(twoLinks)).toEqual(['The spotlight “Kestrel Connect” has 2 links: at most one, to where the feature is set up or used']);
    const list = STRUCTURED.replace('The list and the diff **scroll** on their own.', '- one\n- two');
    expect(notesFormatProblems(list)).toEqual(['“Changes pane” (More changes) has a list: write a sentence or two instead']);
  });

  it('an entry at the limit passes, not counting its link', () => {
    const atLimit = `## Also in this release\n\n### Fits\n\n${'x'.repeat(NOTES_ENTRY_MAX)}\n\n[Open Settings](#/settings)\n`;
    expect(notesFormatProblems(atLimit)).toEqual([]);
    expect(notesFormatProblems(atLimit.replace('xx', 'xxx'))).toHaveLength(1);
  });

  it('a plain file is checked per ## section', () => {
    expect(notesFormatProblems('## Autopilot\n\nSees a pull request through.\n\n[Open Settings → Git](#/settings/git)\n')).toEqual([]);
    expect(notesFormatProblems('## A\n\nSee [B](#/settings).\n\n[Open C](#/code-reviews)\n')).toEqual(['“A” has 2 links: at most one, to where the feature is set up or used']);
    expect(notesFormatProblems('## A\n\nText.\n\n### B\n\nMore.\n')).toEqual(['“A” has a heading inside it: an entry is a headline, a sentence or two and a link']);
    expect(notesFormatProblems('Intro.\n\n## A\n\nText.\n')).toEqual(['there is text before the first section: every part of the notes is a "## " section']);
    expect(notesFormatProblems('## A\n\n[Open Settings](#/settings)\n')).toEqual(['“A” has no description']);
  });

  it('every notes file in the repository keeps it', () => {
    const dir = new URL('../../../whats-new/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const parsed = parseNotes(readFileSync(new URL(name, dir), 'utf8'));
      expect('error' in parsed ? [parsed.error] : notesFormatProblems(parsed.body), name).toEqual([]);
    }
  });

  it('the host copy keeps the section headings and drops in-app links and pictures, captions included', () => {
    const host = hostNotes({ title: 'Kestrel 0.0.32', body: STRUCTURED });
    expect(host).toContain('## Also in this release');
    expect(host).toContain('## More changes');
    expect(host).toContain('### See your sessions from any computer.');
    expect(host).not.toMatch(/\]\(#\/|!\[|\.svg|End-to-end encrypted/);
    expect(host).toContain('Only your devices can read your conversations.\n\n## Also in this release');
  });

  it('a file that looks laid out but misses the sequence fails, naming what is missing', () => {
    const cases: [string, RegExp][] = [
      ['## More changes\n\n### A\n\nB.\n', /no “## Also in this release” section/],
      ['## Connect\n\n### Headline\n\nText.\n', /no “## Also in this release” section/],
      ['## Connect\n\nNo headline.\n\n## Also in this release\n\n### A\n\nB.\n', /the spotlight “Connect” must start with a “### ” headline/],
      ['## A\n\n### x\n\ny.\n\n## B\n\n### x\n\ny.\n\n## Also in this release\n\n### C\n\nD.\n', /must come first, or right after the one spotlight section; before it are “A”, “B”/],
      ['## Also in this release\n\n### A\n\nB.\n\n## Fixes\n\nC.\n', /only “## More changes” may follow, not “Fixes”/],
      ['## Also in this release\n\nLoose.\n\n### A\n\nB.\n', /“## Also in this release” has text before its first “### ” entry/],
    ];
    for (const [body, reason] of cases) {
      const problems = notesFormatProblems(body);
      expect(problems, body).toHaveLength(1);
      expect(problems[0], body).toMatch(/^the notes look laid out as a spotlight, “Also in this release” and “More changes”, but /);
      expect(problems[0], body).toMatch(reason);
    }
  });
});

describe('a drawing of the notes, put inline in the page', () => {
  const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;

  it('keeps a plain drawing as it was, in currentColor', () => {
    const plain = svg('<g stroke="currentColor"><path d="M1 1h8"/><circle class="surface" cx="5" cy="5" r="2"/></g><title>Two &amp; one</title>');
    expect(sanitizeSvg(plain)).toBe(plain);
    expect(sanitizeSvg(`<?xml version="1.0"?>\n<!-- a note -->\n${plain}\n`)).toBe(plain);
  });

  it('leaves out scripts, styles, foreignObject, use, image and links, with everything inside them', () => {
    const out = sanitizeSvg(
      svg('<script>alert(1)</script><style>*{}</style><foreignObject><div>x</div></foreignObject><use href="#a"/><image href="https://example.com/x.png"/><a href="https://example.com"><path d="M0 0"/></a><path d="M1 1"/>'),
    );
    expect(out).toBe(svg('<path d="M1 1"/>'));
  });

  it('leaves out event attributes, style, href and any url(…), data: or javascript: value', () => {
    const out = sanitizeSvg(svg('<path d="M1 1" onclick="alert(1)" onload="x" style="fill:red" fill="url(https://example.com/#p)" stroke="javascript:x" xlink:href="#a" opacity="0.5"/>', ' onload="alert(1)"'));
    expect(out).toBe(svg('<path d="M1 1" opacity="0.5"/>'));
  });

  it('escapes what it keeps, so a value cannot close its quote', () => {
    expect(sanitizeSvg(svg('<path class="a&quot; onclick=&quot;x" d="M1 1"/>'))).toBe(svg('<path class="a&quot; onclick=&quot;x" d="M1 1"/>'));
    expect(sanitizeSvg(svg('<title>&lt;script&gt;</title>'))).toBe(svg('<title>&lt;script&gt;</title>'));
  });

  it('a file that is not one plain <svg> gives nothing', () => {
    for (const bad of ['', '<div></div>', '<!DOCTYPE svg><svg></svg>', svg('<path d="M1 1">'), svg('') + svg(''), 'text ' + svg(''), svg('<![CDATA[x]]>'), svg('<g></path>'), svg('&unknown;'), '<svg/>'])
      expect(sanitizeSvg(bad), bad).toBeNull();
  });

  it('a nested <svg> is left out', () => {
    expect(sanitizeSvg(svg('<svg><path d="M1 1"/></svg><path d="M2 2"/>'))).toBe(svg('<path d="M2 2"/>'));
  });

  it('every drawing shipped with the notes reads as a plain drawing', () => {
    const dir = new URL('../../../whats-new/images/', import.meta.url);
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.svg'))) expect(sanitizeSvg(readFileSync(new URL(name, dir), 'utf8')), name).not.toBeNull();
  });
});
