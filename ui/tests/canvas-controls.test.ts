import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasCardState, readCanvasSize, saveCanvasSize, toggleCanvasFocus } from '../src/pages/canvas-controls.ts';

function stubStorage(context: { after: (restore: () => void) => void }, storage: Pick<Storage, 'getItem' | 'setItem'>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
}

test('card size defaults to Comfortable and is read back from local storage', (context) => {
  const values = new Map<string, string>();
  stubStorage(context, {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  assert.equal(readCanvasSize(), 'comfortable');
  saveCanvasSize('compact');
  assert.equal(readCanvasSize(), 'compact');
  saveCanvasSize('comfortable');
  assert.equal(readCanvasSize(), 'comfortable');
  values.set('kestrel.canvas-card-size', 'unknown');
  assert.equal(readCanvasSize(), 'comfortable');
});

test('blocked local storage leaves the size control usable', (context) => {
  const blocked = () => { throw new Error('Storage disabled'); };
  stubStorage(context, { getItem: blocked, setItem: blocked });
  assert.equal(readCanvasSize(), 'comfortable');
  assert.doesNotThrow(() => saveCanvasSize('compact'));
});

test('focus selects one state, toggles the active state off and clears to all sessions', () => {
  let focus = toggleCanvasFocus(null, 'working');
  assert.equal(focus, 'working');
  focus = toggleCanvasFocus(focus, 'attention');
  assert.equal(focus, 'attention');
  assert.equal(toggleCanvasFocus(focus, 'attention'), null);
  assert.equal(toggleCanvasFocus(focus, null), null);
});

test('cards needing attention keep that state even if working or unread', () => {
  assert.equal(canvasCardState(true, true, true), 'attention');
  assert.equal(canvasCardState(false, true, true), 'working');
  assert.equal(canvasCardState(false, false, true), 'unread');
  assert.equal(canvasCardState(false, false, false), 'quiet');
});
