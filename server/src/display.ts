// What an agent shows the user besides its own text: a drawn widget, a file it made, a next-step
// box, and pictures its tools returned. The checks live here; the runtime only puts the result
// into the conversation as a card.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { AgentEvent, KestrelToolHost, ToolResult } from './agents/types.ts';
import { resolveInside } from './files.ts';
import type { TranscriptAction } from './transcript.ts';
import { Refused } from './workspace.ts';

export const WIDGET_MAX_BYTES = 200 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REPLIES = 3;
const REPLY_MAX = 40;
const RECAP_MAX = 2000;
const ASK_MAX = 300;
const TITLE_MAX = 120;

/** Picture types a tool may return, and the extension each is stored under. */
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
/** Content types by extension, for serving stored pictures and local image files. */
export const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

export type DisplayTools = Pick<KestrelToolHost, 'showWidget' | 'sendFile' | 'nextStep'>;
type Card = Extract<TranscriptAction, { type: 'card' }>;

/** What the display tools need from the runtime. */
export interface DisplayHost {
  directoryOf(sessionId: string): Promise<string | null>;
  projectPaths(): Promise<string[]>;
  showCard(sessionId: string, card: Card): void;
  notice(sessionId: string, text: string, level: 'error'): void;
  /** The sessions whose news the session's turn was given (a child's report, a review's findings). */
  newsFrom(sessionId: string): readonly string[];
}

/** A stored file or session id: no path separators, and no leading dot (so never `..`). */
const SAFE_NAME = /^[\w-][\w.-]*$/;
const safeId = (id: string) => id.replace(/[^\w-]/g, '_').slice(0, 80) || 'image';

export class Display {
  constructor(
    private readonly host: DisplayHost,
    private readonly dataDir: string,
  ) {}

  hostFor(sessionId: string): DisplayTools {
    return {
      showWidget: (a) => this.guard(sessionId, 'show_widget', async () => this.showWidget(sessionId, a)),
      sendFile: (a) => this.guard(sessionId, 'send_file', () => this.sendFile(sessionId, a)),
      nextStep: (a) => this.guard(sessionId, 'next_step', async () => this.nextStep(sessionId, a)),
    };
  }

  /** A refusal goes back to the agent and shows in the conversation, like Kestrel's other tools. */
  private async guard(sessionId: string, tool: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      this.host.notice(sessionId, `Kestrel refused ${tool}: ${error.message}`, 'error');
      return { text: error.message, isError: true };
    }
  }

  private showWidget(sessionId: string, args: { title?: string; code?: string }): ToolResult {
    const code = typeof args.code === 'string' ? args.code.trim() : '';
    if (!code) throw new Refused('code is empty. Pass an SVG starting with <svg, or an HTML fragment.');
    if (Buffer.byteLength(code) > WIDGET_MAX_BYTES) throw new Refused(`The widget is larger than ${WIDGET_MAX_BYTES / 1024} KB. Make it smaller, or write it to a file and use send_file.`);
    const title = (typeof args.title === 'string' ? args.title.trim() : '').slice(0, TITLE_MAX) || 'Widget';
    this.host.showCard(sessionId, { type: 'card', id: `widget-${randomUUID()}`, widget: { title, code } });
    return { text: 'Shown to the user.' };
  }

  private async sendFile(sessionId: string, args: { path?: string; caption?: string }): Promise<ToolResult> {
    const given = typeof args.path === 'string' ? args.path.trim() : '';
    if (!given) throw new Refused('path is empty. Give the path of the file to show.');
    const directory = await this.host.directoryOf(sessionId);
    if (!directory) throw new Refused('This session has no folder on disk.');
    const target = isAbsolute(given) ? given : resolve(directory, given);
    if (!existsSync(target)) throw new Refused(`No such file: ${target}`);
    const path = this.confine(target, await this.agentFileRoots(directory));
    const stat = statSync(path);
    if (!stat.isFile()) throw new Refused(`${path} is not a file. Send one file at a time.`);
    const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim().slice(0, 500) : undefined;
    this.host.showCard(sessionId, { type: 'card', id: `file-${randomUUID()}`, file: { path, name: basename(path), ...(caption ? { caption } : {}), bytes: stat.size } });
    return { text: 'Shown to the user.' };
  }

  /**
   * Where a file an agent puts in front of the user (`send_file`) may be: the session's own folder,
   * Kestrel's scratch folder, and the registered projects. Only for what an agent calls; what the user
   * opens to read by clicking is file-to-read.ts, which no tool reaches.
   */
  private async agentFileRoots(directory: string): Promise<string[]> {
    return [directory, join(this.dataDir, 'scratch'), ...(await this.host.projectPaths())];
  }

  /** The real path of `target` if it is inside one of `roots`; symlinks out of them do not count. */
  private confine(target: string, roots: string[]): string {
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        return resolveInside(root, target);
      } catch {
        // Not under this root; try the next.
      }
    }
    throw new Refused(`${target} is outside this session's folder and the registered projects. Save it in your working folder first.`);
  }

  private nextStep(sessionId: string, args: { recap?: string; ask?: string; replies?: string[] }): ToolResult {
    const recap = typeof args.recap === 'string' ? args.recap.trim() : '';
    if (!recap) throw new Refused('recap is empty. Say in a sentence or two where things stand.');
    if (recap.length > RECAP_MAX) throw new Refused(`recap is longer than ${RECAP_MAX} characters. Keep it to two or three sentences.`);
    const replies = (Array.isArray(args.replies) ? args.replies : []).filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean);
    if (replies.length > MAX_REPLIES) throw new Refused(`At most ${MAX_REPLIES} replies.`);
    const long = replies.find((r) => r.length > REPLY_MAX);
    if (long) throw new Refused(`"${long}" is longer than ${REPLY_MAX} characters. Each reply is a button label: a few words.`);
    const ask = typeof args.ask === 'string' && args.ask.trim() ? args.ask.trim().slice(0, ASK_MAX) : undefined;
    this.host.showCard(sessionId, { type: 'card', id: `next-${randomUUID()}`, next: { recap, ...(ask ? { ask } : {}), replies, ...(this.host.newsFrom(sessionId).length ? { about: [...this.host.newsFrom(sessionId)] } : {}) } });
    return { text: 'Shown to the user.' };
  }

  // ---- pictures from tool results ----------------------------------------------------------

  /** Where a session's pictures are kept. */
  mediaDir(sessionId: string): string {
    return join(this.dataDir, 'media', safeId(sessionId));
  }

  /** Store a picture a tool returned; its file name, or a reason it was not kept. */
  saveImage(sessionId: string, image: Extract<AgentEvent, { type: 'image' }>): { name: string } | { reason: string } {
    const ext = IMAGE_EXT[image.mediaType.toLowerCase()];
    if (!ext) return { reason: `a picture of type ${image.mediaType} was not shown` };
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length === 0) return { reason: 'an empty picture was not shown' };
    if (bytes.length > IMAGE_MAX_BYTES) return { reason: 'a picture larger than 20 MB was not shown' };
    const dir = this.mediaDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const name = `${safeId(image.id)}.${ext}`;
    writeFileSync(join(dir, name), bytes);
    return { name };
  }

  /** The stored picture's path and type, or null when there is no such picture. */
  mediaFile(sessionId: string, name: string): { path: string; type: string } | null {
    if (!SAFE_NAME.test(name) || !SAFE_NAME.test(sessionId)) return null;
    const type = IMAGE_TYPES[name.split('.').pop()!.toLowerCase()];
    const path = join(this.mediaDir(sessionId), name);
    if (!type || !existsSync(path) || !statSync(path).isFile()) return null;
    return { path, type };
  }

  removeMedia(sessionId: string): void {
    rmSync(this.mediaDir(sessionId), { recursive: true, force: true });
  }
}
