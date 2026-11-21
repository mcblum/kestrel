// A preset said in full ("Claude · Sonnet 5.5 · High effort"): the model by the name its agent
// gives it, which only the agent's own list knows (server: shared/who-does-what.ts `presetDetail`).
// One hook for every place a preset is named: the Preset menu, the roles table, the review row.
import type { Agent } from '@kestrel/server/model';
import { modelLabel } from '@kestrel/server/model-choice';
import { presetDetail, type ModelPreset } from '@kestrel/server/who-does-what';
import { useCapabilities } from './useCapabilities.ts';

export function usePresetText(): (preset: Pick<ModelPreset, 'agent' | 'model' | 'effort' | 'fast'>) => string {
  const models: Record<Agent, ReturnType<typeof useCapabilities>['models']> = { claude: useCapabilities('claude').models, codex: useCapabilities('codex').models, opencode: useCapabilities('opencode').models };
  return (preset) => presetDetail(preset, modelLabel(models[preset.agent], preset.model));
}
