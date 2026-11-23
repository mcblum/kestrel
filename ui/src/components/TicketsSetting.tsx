// Settings → Tickets (Matt, 2026-11-22: a section of its own, after Code reviews). One switch at the
// top, off by default, saved as it is changed: while it is off there is no Tickets row in the sidebar,
// no count, and Kestrel asks no tracker (`ticketsOn`). Under it, the sources: one row per tracker
// Kestrel knows, each with its own switch (`ticketSourceOn`), saying what it uses or what it needs
// first. Jira's connection sits under its row. How each source stands is a route answer held once in
// the store (`useResource`); which are on is in the pushed tickets view.
import { useId } from 'react';
import { ready, type Sourced } from '@kestrel/server/sourced';
import { NO_TICKET_SETTINGS, TICKET_SOURCE_LABEL, ticketSourceOn, ticketsOn, withTicketSource, type TicketSettings, type TicketSourceStatus } from '@kestrel/server/tickets';
import { REVIEW_PLACE_LABEL, REVIEW_PLACES, type ReviewPlace } from '@kestrel/server/review-settings';
import { useResource } from '../data/resources.ts';
import { actions, OLDER_SERVER, RESTART_REASON, useApp } from '../store.ts';
import { JiraControls } from './JiraSetting.tsx';
import { LinearControls } from './LinearSetting.tsx';
import { TicketAnswersSetting } from './TicketAnswersSetting.tsx';
import { TicketMatchesSetting } from './TicketMatchesSetting.tsx';
import { SettingSection } from './SettingHelp.tsx';

const SOURCES_PATH = '/api/tickets/sources';
const asStatuses = (raw: unknown): Sourced<TicketSourceStatus[]> => ready(Array.isArray(raw) ? (raw as TicketSourceStatus[]) : []);

const SWITCH_HELP = <p className="settings-help">On, the issues assigned to you show on the Tickets page and its row in the sidebar, the ones in your current sprint first. Off, Kestrel asks no tracker and shows nothing about tickets, except the ticket on work that already has one.</p>;
const SOURCES_HELP = <p className="settings-help">Where tickets are taken from. A source that is switched off is never asked, and its tickets leave the list; work that already has one of its tickets keeps it. When tickets are first turned on, every source that is ready is on.</p>;

const PLACE_NOTE: Record<ReviewPlace, string> = {
  both: 'Show tickets in the sidebar and on the Tickets page.',
  sidebar: 'Show tickets in the sidebar, the ones under way first. Choose "Show more" to see them all.',
  page: 'Show a Tickets link in the sidebar, with a count of new tickets. A ticket’s lead session stays in its project.',
};

/** Where tickets show, as Code reviews has it; saved as it is changed. */
function Place({ show, on }: { show: ReviewPlace; on: boolean }) {
  return (
    <div className="review-setting-place">
      <label className="review-setting-field">
        <span>Where tickets appear</span>
        <select aria-label="Where tickets are shown" className="form-control" value={show} disabled={!on} onChange={(e) => void actions.setTicketSettings({ show: e.target.value })}>
          {REVIEW_PLACES.map((place) => (
            <option key={place} value={place}>
              {REVIEW_PLACE_LABEL[place]}
              {place === NO_TICKET_SETTINGS.show ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-help">{PLACE_NOTE[show]}</p>
    </div>
  );
}

function TicketsSwitch({ on, show }: { on: boolean; show: ReviewPlace }) {
  return (
    <SettingSection title="Assigned tickets" help={SWITCH_HELP}>
      <label className="tag-rule-switch">
        <input type="checkbox" checked={on} onChange={(e) => void actions.setTicketSettings({ on: e.target.checked })} />
        Show the tickets assigned to me
      </label>
      <p className="settings-help">{on ? 'Kestrel checks the sources below every two minutes while a window is open.' : 'Tickets are hidden from the sidebar. Sources are not checked.'}</p>
      <Place show={show} on={on} />
    </SettingSection>
  );
}

/** The badge for a source that cannot be switched on; a ready one says On or Off. */
const STATE_BADGE: Partial<Record<TicketSourceStatus['state'], string>> = { 'needs-setup': 'Setup required', 'not-built': 'Coming soon', sample: 'Sample data' };

function SourceRow({ status, settings, refresh }: { status: TicketSourceStatus; settings: TicketSettings; refresh: () => void }) {
  const id = useId();
  const usable = status.state === 'ready';
  const on = usable && ticketSourceOn(settings, status.id);
  return (
    <div className="ticket-source">
      <div className="ticket-source-header">
      <label className="tag-rule-switch" htmlFor={id}>
        <input id={id} type="checkbox" checked={on} disabled={!usable || !settings.on} onChange={(e) => void actions.setTicketSettings({ off: withTicketSource(settings, status.id, e.target.checked).off })} />
        {TICKET_SOURCE_LABEL[status.id]}
      </label>
      <span className="settings-status">{STATE_BADGE[status.state] ?? (on && settings.on ? 'On' : 'Off')}</span>
      </div>
      {status.state === 'sample' ? null : (
        <>
          <p className="settings-help">{status.line}</p>
          {status.id === 'jira' && <div className="ticket-source-setup"><JiraControls changed={refresh} /></div>}
          {status.id === 'linear' && <div className="ticket-source-setup"><LinearControls changed={refresh} /></div>}
        </>
      )}
    </div>
  );
}

function Sources({ settings }: { settings: TicketSettings }) {
  const { value, refresh } = useResource(SOURCES_PATH, asStatuses);
  return (
    <SettingSection title="Sources" help={SOURCES_HELP}>
      {value.state === 'ready' ? (
        <>
          {/* On sample data every row would say the same, so it is said once. */}
          {value.value.find((s) => s.state === 'sample') && <p className="settings-help">{value.value.find((s) => s.state === 'sample')!.line}</p>}
          {value.value.map((status) => <SourceRow key={status.id} status={status} settings={settings} refresh={() => void refresh()} />)}
        </>
      ) : (
        <p className="settings-help">{value.state === 'loading' ? 'Loading…' : value.reason === RESTART_REASON ? OLDER_SERVER : value.reason}</p>
      )}
    </SettingSection>
  );
}

/** Settings → Tickets: on or off, the sources, the projects tickets start in, then the standing answers to changes. */
export function TicketsSettings() {
  const view = useApp((s) => s.tickets);
  return (
    <>
      <h1>Tickets</h1>
      <TicketsSwitch on={ticketsOn(view)} show={view.settings.show} />
      <Sources settings={view.settings} />
      <TicketMatchesSetting stored={view.settings.matches} on={ticketsOn(view)} />
      <TicketAnswersSetting />
    </>
  );
}
