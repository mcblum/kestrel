import { filterChips, type FilterCounts, type Filters } from '@kestrel/server/status';
import { InboxSearch } from '../components/InboxList.tsx';

/**
 * The one filter bar of a sessions list: status tabs with their counts, then search. Laid out and
 * styled as the bars on Pull requests, Code reviews and Tickets are (styles/inbox-list.css).
 */
export function FilterBar({ counts, filters, onChange }: { counts: FilterCounts; filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="inbox-controls">
      <div className="chips inbox-tabs" role="group" aria-label="Filter by status">
        {filterChips(counts).map((chip) => (
          <button key={chip.key} type="button" className={`chip${filters.status === chip.key ? ' selected' : ''}`} aria-pressed={filters.status === chip.key} onClick={() => onChange({ ...filters, status: chip.key })}>
            {chip.label} <span className="chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      <div className="inbox-toolbar" role="group" aria-label="Search sessions">
        <InboxSearch label="Search sessions" value={filters.query} onChange={(query) => onChange({ ...filters, query })} />
      </div>
    </div>
  );
}
