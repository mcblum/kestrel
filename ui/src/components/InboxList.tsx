import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Ellipsis, Github, Gitlab, Play, Search, Ticket } from 'lucide-react';
import { opener } from '../route.ts';

export function InboxSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="session-search inbox-search">
      <Search aria-hidden />
      <input aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function InboxReference({ service, children }: { service: string; children: ReactNode }) {
  const Icon = service === 'GitHub' ? Github : service === 'GitLab' ? Gitlab : Ticket;
  return (
    <span className="inbox-reference" title={service}>
      <Icon aria-hidden />
      <span className="visually-hidden">{service} </span>
      {children}
    </span>
  );
}

export function InboxRowMenu({ label, onClick }: { label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="icon-button inbox-row-menu" aria-haspopup="menu" aria-label={label} title={label} onClick={onClick}>
      <Ellipsis aria-hidden />
    </button>
  );
}

export function InboxStartButton({ label, reference, onStart }: { label: string; reference: string; onStart: (newTab: boolean) => Promise<void> }) {
  const starting = useRef(false);
  const [pending, setPending] = useState(false);
  const name = pending ? `Starting ${reference}…` : `${label} for ${reference}`;
  return (
    <button
      type="button"
      className="secondary-button small inbox-start"
      aria-label={name}
      title={name}
      disabled={pending}
      {...opener(async (newTab) => {
        if (starting.current) return;
        starting.current = true;
        setPending(true);
        try {
          await onStart(newTab);
        } finally {
          starting.current = false;
          setPending(false);
        }
      })}
    >
      <Play aria-hidden />
      <span>{pending ? 'Starting…' : label}</span>
    </button>
  );
}
