// Settings → Tickets → Projects: which tracker projects or teams belong to which Kestrel project, so Work
// this ticket starts in the right one (server: `matchProject` in tickets/work.ts). Typed, so it is a draft
// saved by the screen's Save bar. The stored matches are the ticket settings pushed to every window.
import { MAX_TICKET_MATCHES, plainName, type TicketMatches } from '@kestrel/server/tickets';
import { useEffect, useState } from 'react';
import { useDraft } from '../unsaved.ts';
import { actions } from '../store.ts';
import { SettingSection } from './SettingHelp.tsx';
import { useHereProjects } from '../awayProjects.ts';

const HELP = (
  <p className="settings-help">
    Work this ticket starts in the Kestrel project that matches the ticket: the one named here for its tracker project or team, else the one whose repository the ticket is in, else the one with the same name. Type the tracker’s project or team as it names it, or its key (PLAT, ENG), separated by commas.
  </p>
);

const NO_MATCHES: TicketMatches = {};

/** What is typed: each project's names as one line. */
const textOf = (matches: TicketMatches): Record<string, string> => Object.fromEntries(Object.entries(matches).map(([id, names]) => [id, names.join(', ')]));
const namesOf = (text: string): string[] => [...new Set(text.split(',').map((n) => n.trim()).filter(Boolean))];
const matchesOf = (text: Record<string, string>): TicketMatches => Object.fromEntries(Object.entries(text).map(([id, t]) => [id, namesOf(t)] as const).filter(([, names]) => names.length > 0));

/** The problem with what is typed, or null. */
function problemOf(matches: TicketMatches, nameOf: (id: string) => string): string | null {
  const seen = new Map<string, string>();
  for (const [id, names] of Object.entries(matches)) {
    if (names.length > MAX_TICKET_MATCHES) return `${nameOf(id)} has more than ${MAX_TICKET_MATCHES} names.`;
    for (const name of names) {
      const key = plainName(name);
      const other = seen.get(key);
      if (other && other !== id) return `${name} is matched to both ${nameOf(other)} and ${nameOf(id)}.`;
      seen.set(key, id);
    }
  }
  return null;
}

/** The tracker projects or teams matched to each Kestrel project. */
export function TicketMatchesSetting({ stored = NO_MATCHES, on }: { stored?: TicketMatches; on: boolean }) {
  const projects = useHereProjects();
  const [text, setText] = useState(() => textOf(stored));
  useEffect(() => setText(textOf(stored)), [stored]);
  const next = matchesOf(text);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const problem = problemOf(next, nameOf);
  const changed = JSON.stringify(next) !== JSON.stringify(matchesOf(textOf(stored)));
  const save = async () => Boolean(await actions.setTicketSettings({ matches: next }));
  const anchor = useDraft({ what: 'Tickets', changed, problem, save, discard: () => setText(textOf(stored)) });
  return (
    <SettingSection title="Projects" help={HELP}>
      {projects.length === 0 ? (
        <p className="settings-help">There are no projects yet.</p>
      ) : (
        projects.map((p) => {
          const id = `ticket-match-${p.id}`;
          return (
            <div key={p.id} className="ticket-answer">
              <label htmlFor={id}>{p.name}</label>
              <input id={id} className="form-control ticket-match" type="text" spellCheck={false} disabled={!on} placeholder="Tracker projects or teams" value={text[p.id] ?? ''} onChange={(e) => setText({ ...text, [p.id]: e.target.value })} />
            </div>
          );
        })
      )}
      {problem && <span className="delegation-limit-problem" role="alert">{problem}</span>}
      <span ref={anchor} className="draft-anchor" />
    </SettingSection>
  );
}
