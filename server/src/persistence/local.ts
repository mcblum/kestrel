// Wraps a synchronous LocalDriver as a Persistence: one operation or transaction at a time,
// in arrival order, so an awaited transaction can never be interleaved with another write.
import type { LocalDriver, Persistence } from './types.ts';

const DATA_METHODS = [
  'isEmpty',
  'listProjects',
  'insertProject',
  'insertFolder',
  'deleteFolder',
  'setFolderOrder',
  'setDefaultFolder',
  'deleteProject',
  'renameProject',
  'getSetting',
  'putSetting',
  'listGroups',
  'insertGroup',
  'renameGroup',
  'deleteGroup',
  'setGroupProject',
  'listSessions',
  'getSession',
  'insertSession',
  'deleteSession',
  'updateSession',
  'setSessionsGroup',
  'markRunningInterrupted',
  'listLinks',
  'insertLink',
  'listTags',
  'tagsOf',
  'setTags',
  'listWorkstreams',
  'insertWorkstream',
  'updateWorkstream',
  'setWorkstreamSessions',
  'deleteWorkstream',
  'listWaits',
  'putWait',
  'deleteWait',
  'deleteWaitsOf',
  'listPins',
  'putPin',
  'setPinOrder',
  'deletePin',
  'getDetail',
  'putDetail',
  'listRequestLinks',
  'listAllRequestLinks',
  'insertRequestLink',
  'setRequestState',
  'listAccountSessions',
  'putAccountSessions',
  'deleteAccountSessions',
  'listAccountDetails',
  'putAccountDetails',
  'deleteAccountDetails',
  'listAccountRecords',
  'putAccountRecord',
  'deleteAccountRecord',
] as const satisfies readonly (keyof LocalDriver & keyof Persistence)[];

export function createLocalPersistence(driver: LocalDriver): Persistence {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.catch(() => undefined);
    return run;
  };

  // Inside a transaction: straight to the driver, no queueing (the transaction holds the queue).
  const direct = {} as Record<string, unknown>;
  // Outside: every call takes its turn in the queue.
  const queued = {} as Record<string, unknown>;
  for (const name of DATA_METHODS) {
    const call = (...args: unknown[]) => (driver[name] as (...a: unknown[]) => unknown)(...args);
    direct[name] = async (...args: unknown[]) => call(...args);
    queued[name] = (...args: unknown[]) => enqueue(() => call(...args));
  }

  const tx = direct as unknown as Persistence;
  tx.transaction = (fn) => fn(tx); // nested: already atomic with the outer one
  tx.close = async () => {
    throw new Error('close() is not available inside a transaction');
  };

  const root = queued as unknown as Persistence;
  root.transaction = (fn) =>
    enqueue(async () => {
      driver.begin();
      try {
        const result = await fn(tx);
        driver.commit();
        return result;
      } catch (error) {
        driver.rollback();
        throw error;
      }
    });
  root.close = () => enqueue(() => driver.close());
  return root;
}
