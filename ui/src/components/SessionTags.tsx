// A session's tags, in its Details pane: small quiet chips, each opening the page of every session with
// that tag and each removable, then "+ tag", which opens a text box in place. Enter adds, Escape or
// leaving the box cancels. The tags already in use elsewhere are offered as you type.
import { useMemo, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { TAG_MAX, hasTag, tagCounts } from '@kestrel/server/tags';
import { opener, openTag } from '../route.ts';
import { actions, useApp } from '../store.ts';

const NO_TAGS: readonly string[] = [];

/** Every tag in use, for the suggestions; the same array until the set of tags changes. */
function useKnownTags(): readonly string[] {
  const sessions = useApp((s) => s.workspace?.sessions);
  return useMemo(() => (sessions ? tagCounts(sessions).map((t) => t.tag) : NO_TAGS), [sessions]);
}

function TagInput({ sessionId, tags }: { sessionId: string; tags: readonly string[] }) {
  const known = useKnownTags();
  const offered = known.filter((t) => !hasTag(tags, t));
  const listId = `tags-${sessionId}`;
  const close = () => actions.startTagging(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') return close();
    if (event.key !== 'Enter') return;
    const tag = event.currentTarget.value.trim();
    close();
    if (tag) void actions.addTag(sessionId, tag);
  };
  return (
    <span className="tag-input-wrap">
      <input className="inline-input tag-input" autoFocus maxLength={TAG_MAX} list={listId} aria-label="New tag" placeholder="Tag" onKeyDown={onKeyDown} onBlur={close} />
      <datalist id={listId}>
        {offered.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </span>
  );
}

export function SessionTags({ sessionId, tags }: { sessionId: string; tags: readonly string[] }) {
  const tagging = useApp((s) => s.tagging === sessionId);
  return (
    <span className="bar-item bar-tags">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          <button className="tag-chip-name" title={`Every session tagged ${tag}`} {...opener((newTab) => openTag(tag, newTab))}>
            {tag}
          </button>
          <button className="tag-chip-remove" aria-label={`Remove the tag ${tag}`} title="Remove tag" onClick={() => void actions.removeTag(sessionId, tag)}>
            <X aria-hidden />
          </button>
        </span>
      ))}
      {tagging ? (
        <TagInput sessionId={sessionId} tags={tags} />
      ) : (
        <button className="tag-add" title="Add a tag" onClick={() => actions.startTagging(sessionId)}>
          <Plus aria-hidden />
          tag
        </button>
      )}
    </span>
  );
}
