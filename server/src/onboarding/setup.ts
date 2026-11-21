import type { Persistence } from '../persistence/types.ts';
import { isOnboardingStep, type OnboardingState, type OnboardingStep } from '../shared/onboarding.ts';

const KEY = 'onboarding-v1';

export class Onboarding {
  constructor(private readonly db: Persistence) {}

  read(): Promise<OnboardingState> {
    return this.db.transaction(async (tx) => {
      const saved = await tx.getSetting(KEY);
      if (isOnboardingStep(saved)) return { step: saved };
      // Includes archived projects/sessions. Existing workspaces never get interrupted by setup.
      // Record the first visit so adding projects cannot hide an unfinished wizard on reload.
      const step = await tx.isEmpty() ? 'welcome' : 'complete';
      await tx.putSetting(KEY, step);
      return { step };
    });
  }

  async save(step: OnboardingStep): Promise<OnboardingState> {
    await this.db.putSetting(KEY, step);
    return { step };
  }
}
