// Options shared by Kestrel's own one-shot questions to Claude Code (a session title, the model
// list): not sessions, so no tools and nothing saved, but they must reach the model the same way
// the user's sessions do.
//
// The user's settings file is read because that is where a provider is often configured: Bedrock,
// Vertex or a gateway, a key helper, and which model "haiku" means there (its `env` block).
// `claudeEnv` drops ANTHROPIC_* and CLAUDE* variables from the environment, so without the file
// such a setup has no way to authenticate and the question fails silently (0.0.1: no generated
// titles on a Bedrock setup). Hooks from that file are switched off: a title is not a session,
// and a SessionStart hook should not run for one.
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { claudeEnv } from './env.ts';
import { claudeExecutable } from './executable.ts';

type Env = Record<string, string | undefined>;

export const sideQueryOptions = (env: Env = process.env): Options => ({
  cwd: tmpdir(),
  env: claudeEnv(env),
  settingSources: ['user'],
  settings: { disableAllHooks: true },
  mcpServers: {},
  strictMcpConfig: true,
  ...claudeExecutable(env),
});
