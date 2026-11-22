// Small things added in 0.0.23 that are words or tables: each is one line to get wrong.
import { describe, expect, test } from 'vitest';
import { DEFAULT_APPEARANCE, SETUP_THEME, SETUP_THEME_NOTE, SETUP_THEMES, THEME_LABEL } from './appearance.ts';
import { NOTIFY_KIND_LABEL } from './notifications.ts';
import { ONBOARDING_STEPS, isOnboardingStep } from './onboarding.ts';
import { PERMISSION_LEVELS, SKIP_PROMPTS, SKIP_PROMPTS_NOTE } from './permissions.ts';
import { acceleratorOf, bindingFor, bindingOf, browserNavCommand, commandFor, formatBinding, menuAccelerators } from './shortcuts.ts';

describe('"Tell me when" reads as one sentence', () => {
  test('every item speaks as the user: "my", never "your"', () => {
    expect(NOTIFY_KIND_LABEL['needs-you']).toBe('A session needs my input');
    for (const label of Object.values(NOTIFY_KIND_LABEL)) expect(label).not.toMatch(/\byou(r)?\b/i);
  });
});

describe('Bypass in the mode menu', () => {
  test('says how it differs from Auto, in its own words and not a listed mode’s hint', () => {
    expect(SKIP_PROMPTS_NOTE).toBe('Full send, no sandboxes or approvals. Use at your own risk.');
    for (const mode of PERMISSION_LEVELS) expect(SKIP_PROMPTS_NOTE).not.toBe(mode.hint);
    expect(PERMISSION_LEVELS.find((m) => m.id === SKIP_PROMPTS)!.place).toBe('bypass');
  });
});

describe('setup asks how Kestrel should look', () => {
  test('the step comes right after the welcome', () => {
    expect(ONBOARDING_STEPS.slice(0, 3)).toEqual(['welcome', 'appearance', 'agents']);
    expect(isOnboardingStep('appearance')).toBe(true);
  });

  test('dark first and chosen until the user picks, then light, then the system’s', () => {
    expect(SETUP_THEMES).toEqual(['dark', 'light', 'system']);
    expect(SETUP_THEME).toBe('dark');
    for (const theme of SETUP_THEMES) expect(THEME_LABEL[theme] && SETUP_THEME_NOTE[theme]).toBeTruthy();
    // Skipping setup changes nothing: the look is still the system's.
    expect(DEFAULT_APPEARANCE.theme).toBe('system');
  });
});

describe('Back and Forward keys', () => {
  const press = (code: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: '', code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  test('a browser’s keys on a Mac: Cmd with [ and ]', () => {
    expect(bindingFor({}, 'back')).toBe('mod+[');
    expect(commandFor({}, bindingOf(press('BracketLeft', { metaKey: true }), true))).toBe('back');
    expect(commandFor({}, bindingOf(press('BracketRight', { metaKey: true }), true))).toBe('forward');
    expect(formatBinding(bindingFor({}, 'forward'), true)).toBe('⌘ ]');
    // Next and previous tab keep Shift with the same keys.
    expect(commandFor({}, 'mod+shift+[')).toBe('prev-tab');
  });

  test('Alt with the arrows on Windows and Linux, and never on a Mac, where it moves the cursor', () => {
    const left = press('ArrowLeft', { altKey: true });
    const right = press('ArrowRight', { altKey: true });
    expect(browserNavCommand(bindingOf(left, false), false)).toBe('back');
    expect(browserNavCommand(bindingOf(right, false), false)).toBe('forward');
    expect(browserNavCommand(bindingOf(left, true), true)).toBeNull();
    expect(browserNavCommand('alt+up', false)).toBeNull();
    expect(browserNavCommand(null, false)).toBeNull();
  });

  test('the desktop menu is given both', () => {
    expect(menuAccelerators({}).back).toBe('CmdOrCtrl+[');
    expect(acceleratorOf('mod+]')).toBe('CmdOrCtrl+]');
  });
});
