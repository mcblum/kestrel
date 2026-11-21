import { isOnboardingStep, type OnboardingState, type OnboardingStep } from '@kestrel/server/onboarding';
import { ready, unavailable, type Sourced } from '@kestrel/server/sourced';
import { appStore, call, putResource } from '../store.ts';

export const SETUP_PATH = '/api/onboarding';
export const asSetup = (raw: unknown) => {
  const step = (raw as Partial<OnboardingState> | null)?.step;
  return isOnboardingStep(step) ? ready({ step }) : unavailable('Could not read setup progress.');
};

/**
 * Setup is under way: it takes the whole window (App.tsx) and the app's own commands wait (commands.ts).
 * Unknown or unreadable progress is not setup: the app is shown then, and its commands work.
 */
export const isSetupOpen = (setup: Sourced<{ step: OnboardingStep }> | undefined): setup is OpenSetup => setup?.state === 'ready' && setup.value.step !== 'complete';

/** Setup progress read, and not finished. */
type OpenSetup = { state: 'ready'; value: { step: Exclude<OnboardingStep, 'complete'> } };

/** `isSetupOpen` for what the store holds now, for code outside React (a key press, the app menu). */
export const setupOpenNow = (): boolean => isSetupOpen(appStore.get().resources.get(SETUP_PATH) as Sourced<{ step: OnboardingStep }> | undefined);

export async function saveSetup(step: OnboardingStep) {
  const state = await call<OnboardingState>(SETUP_PATH, { method: 'PUT', body: JSON.stringify({ step }) });
  putResource(SETUP_PATH, asSetup(state));
}
