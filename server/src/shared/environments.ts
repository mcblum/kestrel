// Where a session can run. Only this machine for now; the control that picks it appears once
// there is something to pick (design doc 2026-11-13, "Layout and wording").
export interface Environment {
  id: string;
  label: string;
}

export const ENVIRONMENTS: readonly Environment[] = [{ id: 'this-mac', label: 'This Mac' }];

/** The environment control is shown only when there is a real choice. */
export const showEnvironmentControl = (environments: readonly Environment[] = ENVIRONMENTS): boolean => environments.length > 1;
