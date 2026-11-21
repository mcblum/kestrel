import { Search } from 'lucide-react';
import { filterChips, type FilterCounts, type Filters } from '@kestrel/server/status';

/** The one filter row: status chips with their counts, and search. */
export function FilterBar({ counts, filters, onChange }: { counts: FilterCounts; filters: Filters; onChange: (next: Filters) => void }) {
  return (
    <div className="filter-row">
      <div className="chips" role="group" aria-label="Filter by status">
        {filterChips(counts).map((chip) => (
          <button key={chip.key} className={`chip${filters.status === chip.key ? ' selected' : ''}`} aria-pressed={filters.status === chip.key} onClick={() => onChange({ ...filters, status: chip.key })}>
            {chip.label} <span className="chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
      <label className="session-search">
        <Search aria-hidden />
        <input value={filters.query} onChange={(e) => onChange({ ...filters, query: e.target.value })} placeholder="Search" aria-label="Search sessions" />
      </label>
    </div>
  );
}
