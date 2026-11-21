import type { ReactNode } from 'react';
import { SettingHeading } from './SettingHelp.tsx';

/** A consistent label/control pair. Use stacked for editors that need the whole width. */
export function SettingRow({ label, htmlFor, help, stacked = false, children }: { label: string; htmlFor?: string; help?: ReactNode; stacked?: boolean; children: ReactNode }) {
  const title = htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label;
  return (
    <div className={`setting-row${stacked ? ' stacked' : ''}`}>
      <div className="setting-row-label">
        {help ? <SettingHeading title={title} label={label} level={3} help={help} /> : title}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}
