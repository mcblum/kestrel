// The model the user's own Claude settings name: `model` in ~/.claude/settings.json, or
// ANTHROPIC_MODEL in that file's `env` block. With one set, that is what a session on "Default"
// actually runs, whatever the SDK's model list calls its default (on Bedrock the list said
// "Opus 5" while the settings ran Opus 5.5). Read only; a missing or unreadable file means none.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The model named by settings JSON (already parsed), or null. `model` wins over the env block. */
export function modelIn(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const { model, env } = settings as { model?: unknown; env?: unknown };
  if (typeof model === 'string' && model.trim()) return model.trim();
  const fromEnv = env && typeof env === 'object' ? (env as Record<string, unknown>).ANTHROPIC_MODEL : undefined;
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : null;
}

export function configuredModel(home: string = homedir()): string | null {
  try {
    return modelIn(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')));
  } catch {
    return null;
  }
}
