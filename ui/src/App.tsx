import { UnsavedDialog } from './components/SaveBar.tsx';
import { SIDEBAR_WIDTH } from '@kestrel/server/sidebar';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { BrowserLayer } from './components/BrowserLayer.tsx';
import { LaunchScreen, useLaunchPhase } from './components/LaunchScreen.tsx';
import { ContextMenuHost } from './components/ContextMenu.tsx';
import { ToastHost } from './components/ToastHost.tsx';
import { NewSessionTab } from './components/NewSessionTab.tsx';
import { SearchPanel } from './components/Panels.tsx';
import { Tooltips } from './components/Tooltips.tsx';
import { SessionWorkspace } from './components/SessionWorkspace.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SidebarFloat } from './components/SidebarFloat.tsx';
import { SidebarRail } from './components/SidebarRail.tsx';
import { SidebarToggle, useFullScreen } from './components/SidebarToggle.tsx';
import { TabStrip } from './components/TabStrip.tsx';
import { UpdateNotice } from './components/UpdateNotice.tsx';
import { WorkspacePage } from './pages/WorkspacePage.tsx';
import { useResource } from './data/resources.ts';
import { asSetup, isSetupOpen, SETUP_PATH } from './onboarding/data.ts';
import { OnboardingWizard } from './onboarding/OnboardingWizard.tsx';
import './onboarding/onboarding.css';
import { commandForKey, runCommand, setSwitcherOpener } from './commands.ts';
import { openFoldersInCreateProject } from './openedFolders.ts';
import { tabRoute } from './route.ts';
import { useCrashReporting } from './components/CrashReportsSetting.tsx';
import { RAIL_WIDTH } from '@kestrel/server/sidebar-mode';
import { setSidebarFloating, useSidebarFloating, useSidebarMode } from './sidebarRail.ts';
import { actions, useApp } from './store.ts';
import { prefetchCapabilities } from './components/controls/useCapabilities.ts';
import { useAgentStatus } from './components/useAgents.ts';
import { activeTab, tabActions, useTabs } from './tabsStore.ts';

export function App() {
  const connection = useApp((s) => s.connection);
  const loaded = useApp((s) => s.workspace !== null);
  const error = useApp((s) => s.error);
  // Setup progress, asked for once the workspace has arrived (the server is reachable then).
  const setup = useResource(loaded ? SETUP_PATH : null, asSetup).value;
  // Kestrel's own failures are reported only when the server says this copy reports (crashReports.ts).
  useCrashReporting(loaded);
  // Settings → Colours: the review and workstream colours, on the page's root (colours.ts).
  const tabsLoaded = useTabs((v) => v.loaded);
  const sidebarWidth = useTabs((v) => v.sidebar.width ?? SIDEBAR_WIDTH.initial);
  // Full, a narrow rail when the window cannot fit it (sidebarRail.ts), or hidden (⌘B).
  const sidebarMode = useSidebarMode();
  const sidebarHidden = sidebarMode === 'hidden';
  const floatOpen = useSidebarFloating() && sidebarMode === 'rail';
  const fullScreen = useFullScreen();
  const tab = useTabs(activeTab);
  const route = tabRoute(tab);
  const activeId = tab.kind === 'session' ? tab.sessionId : null;
  const [switcher, setSwitcher] = useState(false);
  const close = useCallback(() => setSwitcher(false), []);
  // The floating sidebar belongs to the rail: gone once the full sidebar fits again.
  useEffect(() => {
    if (sidebarMode !== 'rail') setSidebarFloating(false);
  }, [sidebarMode]);

  useEffect(() => {
    setSwitcherOpener(() => setSwitcher(true));
    // The same commands whether they come from the keyboard or from Electron's app menu.
    const onKey = (event: KeyboardEvent) => {
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault();
      runCommand(command);
    };
    // In Electron the app menu owns these shortcuts; handling the key here as well would run each twice.
    if (!window.kestrelShell) window.addEventListener('keydown', onKey);
    const offShell = window.kestrelShell?.onCommand(runCommand);
    return () => {
      window.removeEventListener('keydown', onKey);
      offShell?.();
    };
  }, []);

  // Not ready until setup progress is known: a new install goes from the launch screen straight to
  // setup, never through a glimpse of the empty app.
  const ready = loaded && tabsLoaded && setup.state !== 'loading';
  const setupOpen = isSetupOpen(setup);
  // Folders dropped on the Dock icon go to Create project, once the tabs exist to show it in and setup
  // is finished (its window has no tabs). The shell holds them until this asks, so a cold launch with
  // a folder, or one dropped during setup, loses nothing.
  const takesFolders = ready && !setupOpen;
  useEffect(() => (takesFolders ? window.kestrelShell?.onOpenFolders?.(openFoldersInCreateProject) : undefined), [takesFolders]);
  // What each connected agent offers is asked once at start, so a draft draws its model as itself at once.
  const agents = useAgentStatus(ready)?.available;
  useEffect(() => void (agents && prefetchCapabilities(agents)), [agents]);
  const bootFailed = connection === 'no-server' || (!loaded && connection === 'offline');
  const launch = useLaunchPhase(ready || bootFailed);
  if (launch === 'showing') return <LaunchScreen />;
  // Fading: the app is already drawn underneath.
  const veil = launch === 'leaving' ? <LaunchScreen leaving /> : null;

  if (bootFailed) {
    return (
      <div className="kestrel">
        <div className="boot-message">
          <h1>Kestrel’s server is not running</h1>
          <p>
            Start it with <code>pnpm dev:server</code>, then reload this page. The page gets its access token from the server’s launch file, so it has to start first.
          </p>
        </div>
        {veil}
      </div>
    );
  }

  // Setup takes the whole window: no sidebar and no tabs until it is finished or skipped (Matt,
  // 2026-11-19). Finishing it writes the step, and the app below is drawn in its place.
  if (isSetupOpen(setup)) {
    return (
      <div className={`kestrel setup-open${window.kestrelShell?.platform === 'darwin' ? ' mac-chrome' : ''}`}>
        <div className="setup-screen">
          <OnboardingWizard step={setup.value.step} />
        </div>
        <ContextMenuHost />
        <Tooltips />
        {veil}
      </div>
    );
  }

  return (
    <div className={`kestrel${route ? '' : ' session-open'}${window.kestrelShell?.platform === 'darwin' ? ' mac-chrome' : ''}${fullScreen ? ' full-screen' : ''}${sidebarHidden ? ' sidebar-hidden' : ''}${sidebarMode === 'rail' ? ' sidebar-rail' : ''}`} style={{ '--rail-width': `${RAIL_WIDTH}px` } as CSSProperties}>
      <div className="studio-shell" style={{ gridTemplateColumns: sidebarHidden ? 'minmax(0, 1fr)' : `${sidebarMode === 'rail' ? RAIL_WIDTH : sidebarWidth}px minmax(0, 1fr)` }}>
        {sidebarMode === 'full' && <Sidebar route={route} activeId={activeId} onSwitch={() => setSwitcher(true)} />}
        {sidebarMode === 'rail' && <SidebarRail route={route} activeId={activeId} onSwitch={() => setSwitcher(true)} />}
        <main className="studio-main">
          <TabStrip />
          <div className="tab-body">
            {tab.kind === 'session' ? (
              <SessionWorkspace key={tab.id} id={tab.sessionId} />
            ) : tab.kind === 'new' ? (
              <NewSessionTab key={tab.id} tab={tab} />
            ) : (
              route && <WorkspacePage view={route.view} />
            )}
          </div>
        </main>
      </div>
      {floatOpen && (
        <SidebarFloat width={sidebarWidth}>
          <Sidebar route={route} activeId={activeId} onSwitch={() => (setSidebarFloating(false), setSwitcher(true))} />
        </SidebarFloat>
      )}
      <BrowserLayer />
      {/* After the shell on purpose: window drag regions are applied in document order, so this button's no-drag area must come after the sidebar's drag strip or a click on it drags the window. */}
      <SidebarToggle />
      <ToastHost />
      {/* With the sidebar hidden or a rail, the update toast that sits above Settings floats at the bottom-left instead. */}
      {(sidebarHidden || (sidebarMode === 'rail' && !floatOpen)) && <UpdateNotice floating />}
      {switcher && <SearchPanel onClose={close} />}
      <Tooltips />
      <ContextMenuHost />
      <UnsavedDialog />
      {veil}
    </div>
  );
}
