import { describe, expect, test } from 'vitest';
import { KESTREL_KINDS } from './host-kind.ts';
import { needsWindow, WINDOW_THINGS } from './no-window.ts';

describe('needsWindow', () => {
  test('the app refuses nothing: it has a window', () => {
    // Arrange / Act
    const refusals = needsWindow('app', 'Studio Mac');
    // Assert
    for (const thing of WINDOW_THINGS) expect(refusals[thing]).toBeNull();
  });

  test('a node refuses every thing that needs a window, naming the computer', () => {
    const refusals = needsWindow('node', 'Worker node 1');
    for (const thing of WINDOW_THINGS) expect(refusals[thing]).toMatch(/^Worker node 1 has no screen\. .+/);
  });

  test('each refusal says what was asked, in plain words', () => {
    const refusals = needsWindow('node', 'Worker node 1');
    expect(refusals.browser).toContain('browser');
    expect(refusals.simulator).toContain('simulator');
    expect(refusals['open-in']).toContain('Open in');
    expect(refusals.notification).toContain('notification');
    expect(refusals['folder-chooser']).toContain('folder');
    expect(refusals['whats-new']).toContain("What's new");
  });

  test('a desktop notification is refused but phones are said to be still notified', () => {
    expect(needsWindow('node', 'n').notification).toContain('Phones of the account are still notified');
  });

  test('a computer with no name is still named', () => {
    expect(needsWindow('node', '  ').browser).toMatch(/^This computer has no screen\./);
  });

  test('covers every kind and lists each thing once', () => {
    expect(KESTREL_KINDS).toEqual(['app', 'node']);
    expect(new Set(WINDOW_THINGS).size).toBe(WINDOW_THINGS.length);
    for (const kind of KESTREL_KINDS) expect(Object.keys(needsWindow(kind, 'x')).sort()).toEqual([...WINDOW_THINGS].sort());
  });
});
