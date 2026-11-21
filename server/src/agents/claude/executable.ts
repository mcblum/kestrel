// Which Claude Code binary the SDK runs. From a checkout the SDK finds its own (the
// `@anthropic-ai/claude-agent-sdk-<platform>` package beside it). The packaged app ships that same
// binary outside the app archive, where it can be executed, and names it in
// KESTREL_CLAUDE_EXECUTABLE; the SDK's own lookup would point inside the archive.
import type { Options } from '@anthropic-ai/claude-agent-sdk';

type Env = Record<string, string | undefined>;

export const CLAUDE_EXECUTABLE_ENV = 'KESTREL_CLAUDE_EXECUTABLE';

/** The option naming the binary, or nothing when the SDK should find its own. */
export function claudeExecutable(env: Env = process.env): Pick<Options, 'pathToClaudeCodeExecutable'> {
  const path = env[CLAUDE_EXECUTABLE_ENV];
  return path ? { pathToClaudeCodeExecutable: path } : {};
}
