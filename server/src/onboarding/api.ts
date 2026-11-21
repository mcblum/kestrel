import { isOnboardingStep } from '../shared/onboarding.ts';
import type { Onboarding } from './setup.ts';

export async function onboardingRoute(parts: readonly string[], method: string, readBody: () => Promise<Record<string, unknown>>, setup: Onboarding) {
  if (parts[1] !== 'onboarding' || parts.length !== 2) return null;
  if (method === 'GET') return { status: 200, body: await setup.read() };
  if (method !== 'PUT') return null;
  const body = await readBody();
  if (!isOnboardingStep(body.step)) return { status: 400, body: { error: 'Choose a valid setup step.' } };
  return { status: 200, body: await setup.save(body.step) };
}
