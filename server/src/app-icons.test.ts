import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { appBundle, appIcon, appIcons, iconFileIn } from './app-icons.ts';

describe('app icons', () => {
  test('the icon file a bundle names gets .icns when it has no extension', () => {
    expect(iconFileIn('/Applications/Xcode.app', 'Xcode\n')).toBe('/Applications/Xcode.app/Contents/Resources/Xcode.icns');
    expect(iconFileIn('/Applications/Cursor.app', 'Cursor.icns')).toBe('/Applications/Cursor.app/Contents/Resources/Cursor.icns');
  });

  test('an app that is not installed has no bundle and no icon, and nothing throws', async () => {
    expect(appBundle('No Such App 12345')).toBeNull();
    expect(await appIcon('/nonexistent/Nope.app')).toBeNull();
    expect(await appIcons([{ id: 'nope', app: 'No Such App 12345' }, { id: 'none', app: null }])).toEqual({});
  });

  // Finder is on every Mac; elsewhere there is nothing to read.
  test.skipIf(process.platform !== 'darwin' || !existsSync('/System/Library/CoreServices/Finder.app'))('reads a real app icon as a small PNG data URL', async () => {
    const bundle = appBundle('Finder');
    expect(bundle).toBe('/System/Library/CoreServices/Finder.app');
    const icon = await appIcon(bundle!);
    expect(icon).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/);
    expect(icon!.length).toBeLessThan(40_000);
  });
});
