import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A small button that copies a value and shows a tick for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(timer);
  }, [done]);
  const copy = () => void navigator.clipboard.writeText(value).then(() => setDone(true), () => undefined);
  return (
    <button type="button" className="copy-button" aria-label={`Copy ${label}`} title={done ? 'Copied' : `Copy ${label}`} onClick={copy}>
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}
