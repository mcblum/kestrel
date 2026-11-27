// HTTP route for Settings → Workflow → Knowledge base. Shaped like project-edits/api.ts: the caller
// hands over the path parts and a body reader, and gets an answer, or null when the path is not this one.
//
//   GET   /api/knowledge                                        200 KnowledgeView
//   PATCH /api/knowledge  { projectId?: string | null, proposals?: 'ask' | 'never', fetchMinutes?: number }
//                                                               200 KnowledgeView | 400 { error }
//
// The view names the registered projects that are knowledge bases (their default branch holds
// kestrel-knowledge.json), the one in use as it was read, and why it cannot be read when it cannot.
import { Refused } from '../workspace.ts';
import { isFetchMinutes, KNOWLEDGE_FETCH_MINUTES, type KnowledgeSettings } from '../shared/knowledge.ts';
import type { Knowledge } from './service.ts';

export type KnowledgeAnswer = { status: number; body: unknown };
type ReadBody = () => Promise<Record<string, unknown>>;

export async function knowledgeRoute(parts: readonly string[], method: string, readBody: ReadBody, knowledge: Knowledge): Promise<KnowledgeAnswer | null> {
  if (parts[1] !== 'knowledge' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await knowledge.view() };
  if (method !== 'PATCH') return null;
  const body = await readBody();
  const patch: Partial<KnowledgeSettings> = {};
  if ('projectId' in body) {
    if (body.projectId !== null && typeof body.projectId !== 'string') return { status: 400, body: { error: 'projectId must be a project’s id, or null for no knowledge base.' } };
    patch.projectId = body.projectId;
  }
  if ('proposals' in body) {
    if (body.proposals !== 'ask' && body.proposals !== 'never') return { status: 400, body: { error: 'proposals must be "ask" or "never".' } };
    patch.proposals = body.proposals;
  }
  if ('fetchMinutes' in body) {
    if (!isFetchMinutes(body.fetchMinutes)) return { status: 400, body: { error: `fetchMinutes must be one of ${KNOWLEDGE_FETCH_MINUTES.join(', ')}.` } };
    patch.fetchMinutes = body.fetchMinutes;
  }
  if (Object.keys(patch).length === 0) return { status: 400, body: { error: 'Send projectId, proposals or fetchMinutes.' } };
  try {
    await knowledge.setSettings(patch);
  } catch (error) {
    if (error instanceof Refused) return { status: 400, body: { error: error.message } };
    throw error;
  }
  return { status: 200, body: await knowledge.view() };
}
