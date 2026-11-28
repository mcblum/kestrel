import { Monitor } from 'lucide-react';
import '../styles/machines.css';

export function RowMachine({ machine, held = false }: { machine: string; held?: boolean }) {
  const label = `${held ? 'Held' : 'Runs'} on ${machine}`;
  return <span className="row-machine" role="img" aria-label={label} title={label}><Monitor aria-hidden /></span>;
}
