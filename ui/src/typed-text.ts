// Text the user types into keeps the right-click menu of the browser, or of the Mac app's shell
// (app/edit-menu.mjs): spelling suggestions, Cut, Copy and Paste (Matt, 2026-11-24). A page area that
// opens a menu of its own (the sidebar, a row, a tab) leaves a right-click on such text alone, so a
// rename field or a search box inside it still gets that menu. Nothing here depends on the shell.

/** Whether a right-click landed in something typed into: an input that takes text, a text area, or editable content. */
export function isTypedText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])');
  if (!field) return false;
  if (field instanceof HTMLInputElement) return TEXT_INPUTS.has(field.type);
  return true;
}

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
