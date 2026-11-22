import { describe, expect, test } from 'vitest';
import { bannerProblem } from './notifications.ts';
import { FILE_MANAGER_NAME, PLATFORM_NAME, showInFileManager, thisComputer } from './platform.ts';

describe('the words for each platform', () => {
  test('the file manager is named for the computer it is on', () => {
    expect(showInFileManager('mac')).toBe('Show in Finder');
    expect(showInFileManager('windows')).toBe('Show in File Explorer');
    expect(showInFileManager('linux')).toBe('Show in the file manager');
    expect(FILE_MANAGER_NAME.mac).toBe('Finder');
  });

  test('only a Mac is called one', () => {
    expect(thisComputer('mac')).toBe('this Mac');
    expect(thisComputer('windows')).toBe('this computer');
    expect(thisComputer('linux')).toBe('this computer');
    expect(PLATFORM_NAME).toEqual({ mac: 'macOS', windows: 'Windows', linux: 'Linux' });
  });
});

describe('why a notification did not show, off a Mac', () => {
  test('names the system and does not send the user to macOS settings', () => {
    const text = bannerProblem('toast failed', true, 'windows');
    expect(text).toContain('Windows did not show the notification (toast failed)');
    expect(text).not.toMatch(/macOS|System Settings/);
    expect(bannerProblem('x', false, 'linux')).toContain('Linux did not show the notification');
  });

  test('a Mac keeps its own words, and no platform given means a Mac', () => {
    expect(bannerProblem('UNErrorDomain error 1', true)).toMatch(/^macOS is not letting Kestrel show notifications/);
    expect(bannerProblem('unsupported', true, 'linux')).toBe('This computer cannot show notifications; a sound still plays.');
  });
});
