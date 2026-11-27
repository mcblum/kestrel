// A card's own buttons, from its own option list: in the conversation (Decisions.tsx) and on a
// Needs you row (AttentionRow.tsx), so both offer exactly what the agent offered.
import type { InputCard } from '@kestrel/server/model';
import { ALWAYS_CHILDREN, INHERIT_CONFIRM } from '@kestrel/server/sandbox-inherit';

/**
 * A choice that changes a setting for every session asks first: "Always allow for sessions started by another session"
 * (issue 74). The answer then says it was confirmed, which the server requires (sandbox-allow/store.ts): null when the
 * person said no.
 */
function confirmation(optionId: string): CardConfirm | null {
  if (optionId !== ALWAYS_CHILDREN) return {};
  return window.confirm(INHERIT_CONFIRM) ? { confirmed: true } : null;
}

/** What goes with a pick: `confirmed` when the person confirmed a choice that asks first. */
export type CardConfirm = { confirmed?: true };

interface Props {
  card: InputCard;
  onPick: (optionId: string, confirm: CardConfirm) => void;
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
          onClick={() => {
            const confirm = confirmation(o.id);
            if (confirm) onPick(o.id, confirm);
          }}
        >
          {o.id === pendingId ? `${o.label}…` : o.label}
        </button>
      ))}
    </div>
  );
}
