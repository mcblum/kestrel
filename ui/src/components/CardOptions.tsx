// A card's own buttons, from its own option list: in the conversation (Decisions.tsx) and on a
// Needs you row (AttentionRow.tsx), so both offer exactly what the agent offered.
import type { InputCard } from '@kestrel/server/model';

interface Props {
  card: InputCard;
  onPick: (optionId: string) => void;
  /**
   * `explicit`: the first `allow` option is the main button (plans, approvals on a row).
   * `plain`: the card's first option leads, as approval and question boxes always have.
   */
  variant?: 'explicit' | 'plain';
  /** The option being sent: its button says so and every button waits. */
  pendingId?: string | null;
}

export function CardOptions({ card, onPick, variant = 'explicit', pendingId = null }: Props) {
  const primary = variant === 'explicit' ? card.options.find((o) => o.role === 'allow')?.id : undefined;
  const waiting = pendingId !== null;
  return (
    <div className={`decision-options${variant === 'explicit' ? ' explicit' : ''}`}>
      {card.options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={o.id === primary ? 'primary' : o.role === 'deny' ? 'deny' : ''}
          disabled={waiting}
          aria-busy={o.id === pendingId || undefined}
          onClick={() => onPick(o.id)}
        >
          {o.id === pendingId ? `${o.label}…` : o.label}
        </button>
      ))}
    </div>
  );
}
