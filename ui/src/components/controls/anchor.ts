// Opening a menu from one of the controls under the message box: above the button in the
// composer's row (it sits at the bottom of the window), below it elsewhere (Settings), and on the
// other side or shifted when that does not fit (usePopupPlacement). Picks go back to the control
// and focus back to the button when it closes.
import type { MenuItem } from '@kestrel/server/menu';
import { contextMenu } from '../../menuState.ts';
import { opensUpward } from '../usePopupPlacement.ts';

export function openFrom(button: HTMLElement, items: MenuItem[], onPick: (item: MenuItem) => void): void {
  contextMenu.openFrom(button, items, { onPick, above: opensUpward(button), returnFocus: button });
}

/**
 * Whether this button's menu is open as it is pressed. The menu closes on any press outside it, the
 * button's own included, so the click that follows must not open it again.
 */
export const menuOpenFrom = (button: HTMLElement | null): boolean => !!button && contextMenu.current()?.returnFocus === button;
