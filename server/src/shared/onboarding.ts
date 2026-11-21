/** Setup progress belongs to the workspace, shared by the desktop app and browser. */
export const ONBOARDING_STEPS = ['welcome', 'agents', 'projects', 'notifications', 'ready', 'complete'] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export interface OnboardingState { step: OnboardingStep }
export const isOnboardingStep = (value: unknown): value is OnboardingStep =>
  typeof value === 'string' && ONBOARDING_STEPS.some((step) => step === value);
