// A setting's heading with its help: a ? button right after the heading's text, and the help opening
// underneath the heading, above the controls. Closed by default. Keep status and errors out of the help.
import { useId, useState, type ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

type Level = 1 | 2 | 3;

interface SettingHeadingProps {
  title: ReactNode;
  /** What the button is called to a screen reader: "Help: <label>". Defaults to the title when it is text. */
  label?: string;
  help: ReactNode;
  level?: Level;
  id?: string;
  className?: string;
}

export function SettingHeading({ title, label, help, level = 2, id, className }: SettingHeadingProps) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  const Heading = `h${level}` as const;
  const name = label ?? (typeof title === 'string' ? title : 'this setting');
  return (
    <>
      <div className="setting-heading">
        <Heading id={id} className={className}>
          {title}
        </Heading>
        <button type="button" className={`setting-help-toggle${open ? ' open' : ''}`} aria-expanded={open} aria-controls={helpId} aria-label={`Help: ${name}`} title={open ? 'Hide help' : 'Help'} onClick={() => setOpen((was) => !was)}>
          <CircleHelp aria-hidden />
        </button>
      </div>
      <div id={helpId} className="setting-help-content" hidden={!open}>
        {help}
      </div>
    </>
  );
}

/** A Settings section: its heading with help, then the controls. */
export function SettingSection({ title, help, children, id, className = 'settings-section', level = 2 }: { title: string; help: ReactNode; children: ReactNode; id?: string; className?: string; level?: Level }) {
  return (
    <section className={className}>
      <SettingHeading title={title} help={help} id={id} level={level} />
      {children}
    </section>
  );
}
