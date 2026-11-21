// The Pull requests page's data: GET /api/pull-requests, held once in the app store. The server
// builds it from its PR store, so it answers at once; it is asked for again whenever the server
// pushes a change to any session's pull requests (`pullRequestsVersion`) or `refreshKey` changes (the
// sessions in sight changed). What was shown stays on screen while a new answer is on its way, and is
// replaced only when the answer changed. Refresh asks every host again.
import { useCallback, useState } from 'react';
import { isWorkspaceRequests, type PullRequestList } from '@kestrel/server/pull-request-list';
import { ready, unavailable, type Sourced } from '@kestrel/server/sourced';
import { useResource } from '../data/resources.ts';
import { RESTART_REASON, useApp } from '../store.ts';

const PATH = '/api/pull-requests';
const parse = (raw: unknown): Sourced<PullRequestList> => (isWorkspaceRequests(raw) ? ready(raw) : unavailable(RESTART_REASON));

export function useWorkspaceRequests(refreshKey: string): { value: Sourced<PullRequestList>; refreshing: boolean; refresh: () => void } {
  const version = useApp((s) => s.pullRequestsVersion);
  const { value, refresh: ask } = useResource(PATH, parse, `${refreshKey}:${version}`);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    void ask().finally(() => setRefreshing(false));
  }, [ask]);
  return { value, refreshing, refresh };
}
