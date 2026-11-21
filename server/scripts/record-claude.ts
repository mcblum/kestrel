// Records the raw SDK messages of one real Claude run into a JSONL fixture for the mapper tests.
//   pnpm --filter @kestrel/server exec tsx scripts/record-claude.ts <outfile.jsonl>
// Uses haiku, a throwaway directory, and auto-approves every prompt. Not part of the app.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeEnv } from '../src/agents/claude/env.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: record-claude.ts <outfile.jsonl>');
const dir = mkdtempSync(join(tmpdir(), 'kestrel-record-'));
mkdirSync(dir, { recursive: true });
const kestrel = createSdkMcpServer({
  name: 'kestrel',
  version: '0.0.0',
  tools: [tool('list_projects', 'List the projects registered in Kestrel.', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify([{ name: 'demo', path: '/work/demo', isGit: true }]) }] }))],
});
async function* prompt() {
  yield { type: 'user' as const, message: { role: 'user' as const, content: 'Call the list_projects tool from the kestrel server, then create a file hello.txt containing the word hi using the Write tool. Reply in one short sentence.' }, parent_tool_use_id: null, session_id: '' };
}
const lines: string[] = [];
for await (const m of query({
  prompt: prompt(),
  options: {
    model: 'haiku',
    cwd: dir,
    env: claudeEnv(process.env),
    settingSources: [],
    includePartialMessages: true,
    permissionMode: 'default',
    mcpServers: { kestrel },
    allowedTools: ['mcp__kestrel__list_projects'],
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
  },
})) {
  lines.push(JSON.stringify(m));
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`recorded ${lines.length} messages in ${dir} -> ${out}`);
