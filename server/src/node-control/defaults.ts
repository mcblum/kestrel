// What a worker node starts with, only where nobody has said otherwise (docs/designs/worker-nodes.md, section 3).
// Each is a setting that already exists, under its own key; this writes the node's starting choice for it only
// while the store holds none, so a user's later choice (and one made before) always wins.
//
// - Kestrel Connect is on (off by default on a desktop): a node with no window has no one to switch it on.
// - "Other devices may start sessions on this computer" is on (remote-starts/prefs.ts): that is its default
//   everywhere, written down here so a change of that default never turns a node's off.
// - Crash reports are as the installed app has them (on by default, crash-reports/prefs.ts): nothing to write.
import { CONNECT_PREFS_KEY, connectPrefsJson } from '../connect/link/connect.ts';
import { REMOTE_STARTS_KEY, type RemoteStartPrefs } from '../remote-starts/prefs.ts';
import type { SettingStore } from '../suggestions/prefs.ts';

export async function applyNodeDefaults(settings: SettingStore): Promise<void> {
  if ((await settings.getSetting(CONNECT_PREFS_KEY)) === null) await settings.putSetting(CONNECT_PREFS_KEY, connectPrefsJson(true));
  if ((await settings.getSetting(REMOTE_STARTS_KEY)) === null) await settings.putSetting(REMOTE_STARTS_KEY, JSON.stringify({ allowed: true } satisfies RemoteStartPrefs));
}
