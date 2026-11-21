import { useId, type ReactNode } from 'react';

export interface SettingsItem<Key extends string> {
  id: Key;
  label: string;
  content: ReactNode;
}

/** Route-controlled sections. Keep panels mounted so switching sections preserves drafts. */
export function SettingsLayout<Key extends string>({ label, sections, active, onSelect }: { label: string; sections: readonly SettingsItem<Key>[]; active: Key; onSelect: (section: Key) => void }) {
  const id = useId();
  return (
    <div className="settings-layout">
      <nav className="settings-layout-nav" aria-label={label}>
        {sections.map((section) => (
          <button key={section.id} id={`${id}-${section.id}-nav`} type="button" aria-current={active === section.id ? 'page' : undefined} aria-controls={`${id}-${section.id}`} onClick={() => onSelect(section.id)}>
            {section.label}
          </button>
        ))}
      </nav>
      <div className="settings-layout-body">
        {sections.map((section) => (
          <div key={section.id} id={`${id}-${section.id}`} role="region" aria-labelledby={`${id}-${section.id}-nav`} hidden={active !== section.id}>
            {section.content}
          </div>
        ))}
      </div>
    </div>
  );
}
