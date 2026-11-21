// The environment the Claude SDK runs with. One rule however the server was started: the
// whole environment, minus anything that would change how the agent signs in. Sign-in is the
// Claude login already on this Mac (the Max subscription); no API key is read, asked for or
// stored. Variables a parent Claude session exports (CLAUDE*, CLAUDECODE) are dropped so the
// child does not think it is nested; ANTHROPIC_* (keys, tokens, base URLs) and the
// Bedrock/Vertex switches would redirect auth, so they are dropped too.

type Env = Record<string, string | undefined>;

const DENY_PREFIXES = ['CLAUDE', 'ANTHROPIC_', 'AWS_BEARER_TOKEN_BEDROCK'];

export function claudeEnv(env: Env): Env {
  const out: Env = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DENY_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}
