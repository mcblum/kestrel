// `kestrel node configure` in a real terminal: the flow (setup-flow.ts) drawn as `join` is, its questions read from the
// keyboard, each step the very command it names (join-terminal.ts, agents-terminal.ts, git-terminal.ts), and the
// running node asked only `status`. With input or output not a terminal (the install piped from curl with no
// terminal to open), nothing is asked: what is left is listed with each command.
import { nodeAgentsEnv } from '../agents/kestrel-agents.ts';
import { hostPlatform } from '../host.ts';
import type { NodeJoinEvent } from '../shared/node-commands.ts';
import { serviceLine } from '../shared/node-host.ts';
import { missingSandboxPackages, sandboxInstallCommand } from '../shared/node-sandbox.ts';
import type { ChecklistIo } from './agents-checklist.ts';
import { agentsFromTerminal, onPath, terminalIo } from './agents-terminal.ts';
import { askNode, nodeAnswers, waitUntil } from './client.ts';
import { gitFromTerminal } from './git-terminal.ts';
import { runForOutput, serviceState } from './host-facts.ts';
import { joinFromTerminal } from './join-terminal.ts';
import { unitAction } from './service.ts';
import { runSetup, type SetupDeps } from './setup-flow.ts';
import { nodeSocketPath } from './socket-path.ts';

/** A checklist drawn inside setup: as on its own, less the closing "Next:" line, since setup goes on to what is next. */
function withoutNext(io: ChecklistIo): ChecklistIo {
  return { ...io, say: (event: NodeJoinEvent) => io.say(event.event === 'end' ? { event: 'end', ok: event.ok, text: event.text } : event) };
}

export async function setupFromTerminal(home: string, dataDir: string): Promise<number> {
  const path = nodeSocketPath(dataDir);
  const io = terminalIo();
  const has = onPath(nodeAgentsEnv(process.env, dataDir));
  const service = () => serviceState({ platform: hostPlatform(), run: runForOutput });
  const deps: SetupDeps = {
    status: async () => {
      if (!(await nodeAnswers(path))) return null;
      const reply = await askNode(path, 'status').catch(() => null);
      return reply?.ok && reply.status ? reply.status : null;
    },
    sandboxHere: () => ({ missing: missingSandboxPackages(has), install: sandboxInstallCommand(has) }),
    waitForNode: (ms) => waitUntil(path, true, ms),
    notRunning: async () => serviceLine(await service(), null),
    run: async (command) => {
      const sub = withoutNext(terminalIo());
      const code = command === 'join' ? await joinFromTerminal(path, { next: false }) : command === 'agents' ? await agentsFromTerminal(home, dataDir, { only: null, yes: false, check: false }, sub) : await gitFromTerminal(home, dataDir, { yes: false, manual: false }, sub);
      // The command printed on its own: what setup says next starts a new block.
      io.ran();
      return code;
    },
    restart: async () => {
      const now = await service();
      if (now.manager !== 'systemd' || !now.installed) return { ok: false, line: 'This node was started by hand, so setup cannot restart it. Stop it ("kestrel node stop") and start it again ("kestrel node run").' };
      return unitAction('restart');
    },
  };
  return runSetup(deps, io, { interactive: process.stdin.isTTY === true && process.stdout.isTTY === true });
}
