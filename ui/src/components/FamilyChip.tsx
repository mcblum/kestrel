// The chip in a session's header that names the work it is part of (Matt, 2026-11-24): its workstream
// ("Usage-based pricing · 2 child PRs · 1 failing"), the same on every session of it, or, for a session
// in no workstream that delegated, the sessions it started ("3 sessions it started · 2 PRs"). The words
// come from @kestrel/server/request-family and read without colour; the chip is neutral.
//
// A click opens a menu on the app's menu surface: "Open workstream" (a workstream only), then the lead,
// labelled, then the rest one level under it on the sidebar's elbow, what needs the user first. Each
// row opens its session and shows its request (number, state word, a link to it on the host) or, with
// none, its working state. The row of the session whose header this is has the selected look and says
// "this session". Keys: Enter or Space opens, arrows move, Escape closes.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ExternalLink, ListTree, Waypoints } from 'lucide-react';
import { familyCountText, familyDescription, type FamilyMember } from '@kestrel/server/request-family';
import { hostTerms, requestNumber } from '@kestrel/server/host-terms';
import type { SessionView } from '@kestrel/server/model';
import { useFamily } from '../family.ts';
import { statusText } from '../labels.ts';
import { openSession, openView, wantsNewTab } from '../route.ts';
import { CardRequestIcon } from './CardRequests.tsx';
import { Popup } from './Popup.tsx';

function useOutside(open: boolean, host: React.RefObject<HTMLElement | null>, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !host.current?.contains(e.target as Node) && latest.current();
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, host]);
}

export function FamilyChip({ sessionId }: { sessionId: string }) {
  const family = useFamily(sessionId);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useOutside(open, host, () => close(false));
  useEffect(() => {
    if (open) items.current[focus]?.focus();
  }, [open, focus]);
  if (!family) return null;

  const offset = family.workstream ? 1 : 0;
  const count = family.members.length + offset;
  const onKeys = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step) setFocus((f) => (f + step + count) % count);
    else if (e.key === 'Escape') close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const go = (act: (newTab: boolean) => void) => (event: React.MouseEvent) => (act(wantsNewTab(event)), close(false));
  const description = familyDescription(family);

  return (
    <div className="picker family-chip-host" ref={host}>
      <button ref={button} type="button" className="tag-chip family-chip" aria-haspopup="menu" aria-expanded={open} aria-label={description} title={description} onClick={() => (open ? close(true) : (setFocus(0), setOpen(true)))}>
        {family.workstream ? <Waypoints aria-hidden /> : <ListTree aria-hidden />}
        {family.workstream && <span className="family-chip-name">{family.workstream.name}</span>}
        <span className="family-chip-count">
          {family.workstream && '· '}
          {familyCountText(family)}
        </span>
        <span className="family-chip-caret" aria-hidden />
      </button>
      {open && (
        <Popup anchor={button} side="below" className="context-menu family-menu" role="menu" aria-label={family.workstream ? `Workstream ${family.workstream.name}` : 'Sessions it started'} onKeyDown={onKeys}>
          {family.workstream && (
            <>
              <button ref={(el) => void (items.current[0] = el)} type="button" role="menuitem" className="menu-item" tabIndex={focus === 0 ? 0 : -1} onMouseEnter={() => setFocus(0)} onClick={go((newTab) => openView({ kind: 'workstream', id: family.workstream!.id }, newTab))}>
                <Waypoints aria-hidden />
                <span>Open workstream</span>
              </button>
              <div className="menu-sep" role="separator" />
            </>
          )}
          {family.members.map((member, i) => (
            <MemberRow key={member.session.id} member={member} host={family.host} current={member.session.id === sessionId} focused={focus === i + offset} rowRef={(el) => void (items.current[i + offset] = el)} onFocus={() => setFocus(i + offset)} onOpen={go((newTab) => openSession(member.session.id, newTab))} />
          ))}
        </Popup>
      )}
    </div>
  );
}

interface RowProps {
  member: FamilyMember<SessionView>;
  host: Parameters<typeof hostTerms>[0];
  current: boolean;
  focused: boolean;
  rowRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onOpen: (event: React.MouseEvent) => void;
}

function MemberRow({ member, host, current, focused, rowRef, onFocus, onOpen }: RowProps) {
  const { session, isLead, request } = member;
  const terms = hostTerms(request?.host ?? host);
  const number = request ? requestNumber(terms, request.pr.number) : null;
  const state = request ? `${number} ${request.label}` : statusText(session);
  return (
    <div className={`menu-slot family-row${isLead ? ' lead' : ' child'}${current ? ' current' : ''}`}>
      <button ref={rowRef} type="button" role="menuitem" className="menu-item" tabIndex={focused ? 0 : -1} aria-current={current ? 'page' : undefined} title={`${session.title} · ${state}`} onMouseEnter={onFocus} onClick={onOpen}>
        <span className="family-row-name">
          <span className="family-row-title">{session.title}</span>
          {isLead && <small className="family-row-tag">Lead</small>}
          {current && <small className="family-row-tag">this session</small>}
        </span>
        <span className="family-row-state">
          {request && <CardRequestIcon tone={request.tone} alert={request.needsYou} />}
          <span>{request ? `${number} · ${request.label}` : state}</span>
        </span>
      </button>
      {request?.pr.url && (
        <a className="family-row-link" href={request.pr.url} target="_blank" rel="noreferrer" aria-label={`Open ${number} on ${terms.service}`} title={`Open ${number} on ${terms.service}`}>
          <ExternalLink aria-hidden />
        </a>
      )}
    </div>
  );
}
