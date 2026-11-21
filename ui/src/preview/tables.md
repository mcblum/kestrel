### Read (4)

| Tool | What it does |
| --- | --- |
| `get_overview()` | System-health dashboard: counts by state, status, team and env, plus the top active issues, a 30-day trend and recent scans |
| `list_issues(status?, state?, env?, team?, search?, sort?, page?, page_size?)` | Filter and page through issues |
| `get_issue(dedupe_key, observation_limit?)` | Full detail for one issue, including observations and the latest investigation report |
| `get_issue_events(dedupe_key, limit?)` | An issue’s audit timeline: who did what, from where, why, and the exact change; this is where you find the `event_id` to pass to `revert_issue` |

### Write: audited and reversible

Every action requires `reasoning`, which is recorded on the audit event.

| Tool | What it does |
| --- | --- |
| `acknowledge_issue(dedupe_key, reasoning, user?)` | Mark as acknowledged |
| `snooze_issue(dedupe_key, until, reasoning, user?)` | Snooze until an ISO-8601 time |
| `revert_issue(event_id, reasoning)` | Revert a specific audited change |

### Column alignment

| Service | Status | Runs | Success rate |
| :--- | :---: | ---: | ---: |
| API | Passing | 128 | 99.2% |
| Worker | Running | 32 | 96.9% |

### Wide tables

| Service | Environment | Owner | Region | Build | Last run | Result | Duration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| API | Production | Platform | US East | `abcdef123` | Today, 10:30 | Passing | 2m 14s |
