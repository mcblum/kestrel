// The names to choose on a suggestion card that offers some (`Suggestion.picks`; a tag card's tags):
// a few of the user's existing tags as chips to click, the suggested one first and marked, and a field
// that holds what is chosen as chips and takes typed names. Enter or a comma makes a chip of what was
// typed (an existing tag in its own writing, whatever the case typed); Backspace in the empty field
// takes the last chip off. The first existing tag clicked takes the suggested one's place; after any
// change of the user's own, a click adds or removes. The choice is the card's draft: nothing is tagged until a button is pressed.
// A chip's colour is its tag's (Settings → Colours); everything else is grey.
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { Check, Lightbulb, X } from 'lucide-react';
import { tagColour } from '@kestrel/server/colours';
import type { SuggestionPicks as Picks } from '@kestrel/server/suggestions';
import { MAX_PICKED_TAGS, withClicked, withTyped } from '@kestrel/server/tag-match';
import { TAG_MAX, hasTag, removeTag } from '@kestrel/server/tags';
import { tintFor, useColours } from '../colours.ts';

interface SuggestionPicksProps {
  picks: Picks;
  /** Every tag in use, so a typed name follows the existing tag's writing. */
  known: readonly string[];
  chosen: readonly string[];
  /** The choice is still as the card came: the first other chip clicked then replaces the suggestion. */
  untouched: boolean;
  typing: string;
  disabled: boolean;
  onChosen: (chosen: readonly string[]) => void;
  onTyping: (text: string) => void;
}

export function SuggestionPicks({ picks, known, chosen, untouched, typing, disabled, onChosen, onTyping }: SuggestionPicksProps) {
  const colours = useColours();
  const full = chosen.length >= MAX_PICKED_TAGS;
  const tint = (tag: string) => tintFor(tagColour(colours, tag));
  const commit = (text: string) => {
    onChosen(withTyped(chosen, text, known));
    onTyping('');
  };
  const toggle = (tag: string) => onChosen(withClicked(chosen, tag, untouched));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The window's own shortcuts are not for a field being typed into.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(typing);
    } else if (event.key === 'Backspace' && typing === '' && chosen.length) {
      event.preventDefault();
      onChosen(chosen.slice(0, -1));
    }
  };
  // Pasted names split at their commas, as typed ones do.
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text.includes(',')) return;
    event.preventDefault();
    commit(typing + text);
  };
  return (
    <div className="suggestion-picks">
      <div className="suggestion-offered" role="group" aria-label="Tags to choose">
        {[...picks.chosen, ...picks.offered].map((tag) => {
          const on = hasTag(chosen, tag);
          const suggested = hasTag(picks.chosen, tag);
          const t = tint(tag);
          return (
            <button key={tag} type="button" className={`tag-chip suggestion-pick${t.className}`} style={t.style} aria-pressed={on} disabled={disabled || (!on && full)} title={suggested ? `Suggested: ${tag}` : on ? `Chosen: ${tag}` : untouched ? `Tag with ${tag} instead` : `Tag with ${tag} too`} onClick={() => toggle(tag)}>
              {suggested ? <Lightbulb aria-label="Suggested" /> : on ? <Check aria-hidden /> : null}
              <span>{tag}</span>
            </button>
          );
        })}
      </div>
      <label className="suggestion-field">
        {chosen.map((tag) => {
          const t = tint(tag);
          return (
            <span key={tag} className={`tag-chip${t.className}`} style={t.style}>
              <span className="suggestion-chip-name">{tag}</span>
              <button type="button" className="tag-chip-remove" aria-label={`Do not tag with ${tag}`} title="Remove" disabled={disabled} onClick={() => onChosen(removeTag(chosen, tag))}>
                <X aria-hidden />
              </button>
            </span>
          );
        })}
        <input
          className="suggestion-field-input"
          value={typing}
          maxLength={TAG_MAX}
          disabled={disabled || full}
          aria-label="Add a tag"
          placeholder={full ? `${MAX_PICKED_TAGS} tags at most` : chosen.length ? 'Add a tag' : 'Type a tag, then Enter'}
          onChange={(e) => onTyping(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </label>
    </div>
  );
}
