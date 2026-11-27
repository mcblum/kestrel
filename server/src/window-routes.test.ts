import { describe, expect, test } from 'vitest';
import { windowThingOf } from './window-routes.ts';

const of = (method: string, path: string) => windowThingOf(path.split('/').filter(Boolean), method);

describe('windowThingOf', () => {
  test('the simulator pane and What’s new are window things on every method', () => {
    expect(of('GET', '/api/simulator')).toBe('simulator');
    expect(of('POST', '/api/simulator/ABCDEF/boot')).toBe('simulator');
    expect(of('GET', '/api/whats-new')).toBe('whats-new');
    expect(of('POST', '/api/whats-new/shown')).toBe('whats-new');
  });

  test('Open in is the POSTs that start an app on the screen', () => {
    expect(of('POST', '/api/sessions/s1/open-file')).toBe('open-in');
    expect(of('POST', '/api/sessions/s1/reveal-file')).toBe('open-in');
    expect(of('POST', '/api/open-folder')).toBe('open-in');
    expect(of('GET', '/api/editors')).toBeNull();
  });

  test('listing folders to choose from is the folder chooser', () => {
    expect(of('POST', '/api/projects/list-folder')).toBe('folder-chooser');
    expect(of('POST', '/api/projects/create')).toBeNull();
  });

  test('ordinary routes are none of these', () => {
    expect(of('GET', '/api/state')).toBeNull();
    expect(of('POST', '/api/sessions/s1/reply')).toBeNull();
  });
});
