// The worker node's entry point, `kestrel-node` (docs/designs/worker-nodes.md, sections 3 and 4): Kestrel's server
// with no window, started by a service instead of by Electron. It calls the same start function as index.ts. With no
// argument (or `run`) it starts; every other command is done in this terminal, asking the running node over its
// control socket what only it can answer (node-control/terminal.ts).
import { homedir } from 'node:os';
import { dataDir as resolveDataDir } from './data-dir.ts';
import { nodeAgentsEnv } from './agents/kestrel-agents.ts';
import { useHostKind } from './host.ts';
import { DEFAULT_LOG_LINES, parseCliArgs, usage } from './node-control/args.ts';
import { runNode } from './node-control/run.ts';
import { runCommand } from './node-control/terminal.ts';

const cli = parseCliArgs(process.argv.slice(2));
const dataDir = resolveDataDir();
// Every kestrel-node, the service and a command typed in a terminal alike, is a worker node's, and runs the agents in
// one environment: Kestrel's agents folder and the bundle's Node first on PATH (agents/kestrel-agents.ts), so what
// `kestrel-node agents` installs is what the node finds and can start.
useHostKind('node');
process.env.PATH = nodeAgentsEnv(process.env, dataDir).PATH;

if (cli.action === 'help') {
  console.log(usage());
} else if (cli.action === 'error') {
  console.error(`${cli.reason}\n${usage()}`);
  process.exitCode = 2;
} else if (cli.action === 'command') {
  process.exitCode = await runCommand({ home: homedir(), dataDir }, cli.command, cli.logs ?? { follow: false, lines: DEFAULT_LOG_LINES }, cli.agents, { ...(cli.git ? { git: cli.git } : {}), ...(cli.json ? { json: true } : {}) });
} else {
  await runNode({ dataDir, port: Number(process.env.KESTREL_NODE_PORT ?? 4318), env: process.env });
}
