// A saved action's preview address (server: shared/saved-actions.ts): once the server says it
// answers, it opens in the scope's browser pane; in a plain browser, where there is no pane, in a
// new tab. One that never answered is said, not dropped.
import { browserPane } from './browserStore.ts';
import { actions } from './store.ts';

export async function showActionPreview(scopeKey: string, preview: { name: string; url: string; ready: boolean }): Promise<void> {
  if (!preview.ready) return actions.showError(`${preview.name} started, but nothing answered at ${preview.url} within a minute. Look at its terminal.`);
  try {
    if (!(await browserPane.open(scopeKey, preview.url))) window.open(preview.url, '_blank', 'noopener');
  } catch (error) {
    actions.showError(`${preview.name}'s preview could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
}
