import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/appearance.css';
import './styles/prototype.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/step-notes.css';
import './styles/terminal-tabs.css';
import './styles/browser-pane.css';
import './styles/simulator-pane.css';
import './styles/pane-layout.css';
import './styles/queue-attention.css';
import './styles/pictures.css';
import './styles/approvals.css';
import './styles/conversation-width.css';
import './styles/conversation-list.css';
import './styles/foot.css';
import './styles/update-toast.css';
import './styles/details.css';
import './styles/pane-head.css';
import './styles/commands.css';
import './styles/organize.css';
import './styles/sidebar-rhythm.css';
import './styles/sidebar-create.css';
import './styles/sidebar-rows.css';
import './styles/sidebar-rail.css';
import './styles/row-request.css';
import './styles/pull-request-group.css';
import './styles/pull-requests-page.css';
import './styles/review-requests.css';
import './styles/inbox-list.css';
import './styles/tickets.css';
import './styles/scrollbars.css';
import './styles/crash.css';
import './styles/project-folders.css';
import './styles/form-page.css';
import './styles/folder-batch.css';
import './styles/suggestions.css';
import './styles/sandbox-allow.css';
import './styles/delegation-limits.css';
import './styles/page-header.css';
import './styles/project-page.css';
import './styles/attachments.css';
import './styles/turn-foot.css';
import './styles/composer-box.css';
import './styles/message-input.css';
import './styles/slash-menu.css';
import './styles/composer-controls.css';
import './styles/background-tasks.css';
import './styles/focus-ring.css';
import './styles/settings.css';
import './styles/colours.css';
import { CrashBoundary } from './components/CrashScreen.tsx';
import { installAppearance } from './appearance.ts';
import { installFocusRing } from './focusRing.ts';
import { installNotifier } from './notifier.ts';
import { installShortcuts } from './shortcuts.ts';
import { installNavHistory } from './navHistory.ts';

installAppearance();
installFocusRing();
installNotifier();
installShortcuts();
installNavHistory();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>,
);
