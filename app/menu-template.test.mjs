import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuTemplate } from './menu-template.mjs';

const build = (platform) => menuTemplate(() => undefined, { devTools: false, checkForUpdates: () => undefined, platform, appName: 'Kestrel' });
const labels = (template) => template.map((menu) => menu.label ?? menu.role);
const roles = (menu) => menu.submenu.map((item) => item.role).filter(Boolean);

test('a Mac gets the app menu first, with Quit and Check for Updates in it', () => {
  const template = build('darwin');
  assert.deepEqual(labels(template), ['Kestrel', 'File', 'editMenu', 'Tab', 'View', 'windowMenu']);
  assert.ok(roles(template[0]).includes('quit'));
  assert.ok(template[0].submenu.some((item) => item.label === 'Check for Updates…'));
  assert.ok(!roles(template[1]).includes('quit'));
});

for (const platform of ['win32', 'linux']) {
  test(`${platform} has no app menu: Quit is in File, About and Check for Updates in Help`, () => {
    const template = build(platform);
    assert.deepEqual(labels(template), ['File', 'editMenu', 'Tab', 'View', 'windowMenu', 'Help']);
    assert.ok(roles(template[0]).includes('quit'));
    const help = template.at(-1);
    assert.ok(help.submenu.some((item) => item.label === 'Check for Updates…'));
    assert.ok(roles(help).includes('about'));
    // Services, Hide and Unhide exist on a Mac only.
    const everyRole = template.flatMap((menu) => (Array.isArray(menu.submenu) ? roles(menu) : []));
    for (const macOnly of ['services', 'hide', 'hideOthers', 'unhide']) assert.ok(!everyRole.includes(macOnly), macOnly);
  });
}

test('the user’s own key replaces the default, and an empty one takes the key away', () => {
  const template = menuTemplate(() => undefined, { devTools: false, checkForUpdates: () => undefined, platform: 'linux', accelerators: { 'new-session': 'Ctrl+Alt+N', switch: '' } });
  const file = template[0].submenu;
  assert.equal(file.find((item) => item.label === 'New Session').accelerator, 'Ctrl+Alt+N');
  assert.equal('accelerator' in file.find((item) => item.label === 'Switch Session…'), false);
});

test('Back and Forward are in the View menu with a browser’s keys', () => {
  const view = menuTemplate(() => undefined, { devTools: false, checkForUpdates: () => undefined, platform: 'darwin' }).find((menu) => menu.label === 'View').submenu;
  assert.equal(view.find((item) => item.label === 'Back').accelerator, 'CmdOrCtrl+[');
  assert.equal(view.find((item) => item.label === 'Forward').accelerator, 'CmdOrCtrl+]');
});
