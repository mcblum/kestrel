// Where a worker node's control socket is, and the checks that make it private to the user (docs/designs/
// worker-nodes.md, section 3). A Unix domain socket's path is short by the system's limit, so a data folder
// with a long path is refused with that reason instead of failing somewhere inside `listen`.
import { join } from 'node:path';
import { Refused } from '../refused.ts';

export const NODE_SOCKET_FILE = 'node.sock';

/** The longest socket path the systems allow is 104 bytes (macOS) or 108 (Linux), counting the final zero. */
export const SOCKET_PATH_MAX_BYTES = 100;

export const nodeSocketPath = (dataDir: string): string => join(dataDir, NODE_SOCKET_FILE);

/** Throws `Refused` when `path` is too long for a Unix socket. */
export function checkSocketPathLength(path: string): void {
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX_BYTES) throw new Refused(`The node's control socket would be at ${path}, which is too long for a Unix socket (at most ${SOCKET_PATH_MAX_BYTES} bytes). Use a shorter KESTREL_DATA_DIR.`);
}
