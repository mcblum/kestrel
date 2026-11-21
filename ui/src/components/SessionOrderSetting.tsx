// Settings → General → Sidebar: how sessions are ordered inside each sidebar list (the Sessions list,
// each group, each project, each tag). Kept with the sidebar's own prefs on the server, so it holds
// across restarts and every window agrees; it applies at once. PINNED follows it too
// (shared/pinned-order.ts: pinned sessions only); groups, projects and tags keep the user's order either way.
import { SettingHeading } from './SettingHelp.tsx';
import { SESSION_ORDERS, type SessionOrder } from '@kestrel/server/session-order';
import { tabActions, useSessionOrder } from '../tabsStore.ts';

const LABEL: Record<SessionOrder, string> = {
  recent: 'Most recent first',
  custom: 'Custom order (drag to arrange)',
};

const HELP: Record<SessionOrder, string> = {
  recent: 'Sessions move to the top of their list when you send a message or a turn ends.',
  custom: 'Sessions stay where you drag them; new ones start at the top.',
};

export function SessionOrderSetting() {
  const current = useSessionOrder();
  return (
    <section className="settings-section">
      <SettingHeading
        id="session-order"
        title="Session order"
        help={<p className="settings-help">{HELP[current]} {current === 'recent' ? 'Pinned sessions sort the same way. Groups, projects and tags keep the order you give them, pinned or not.' : 'Groups, projects, tags and pinned items keep the order you give them.'}</p>}
      />
      <div className="settings-choices" role="radiogroup" aria-labelledby="session-order">
        {SESSION_ORDERS.map((value) => (
          <label key={value} className="settings-choice">
            <input type="radio" name="session-order" value={value} checked={current === value} onChange={() => tabActions.setSessionOrder(value)} />
            {LABEL[value]}
          </label>
        ))}
      </div>
    </section>
  );
}
