// Settings, in the main canvas: a list of sections on the left, the chosen one on the right. App-wide
// only: a project's own settings are on its page's Settings tab. Nothing opens in a panel from the side.
import { TicketsSettings } from '../components/TicketsSetting.tsx';
import { SaveBar } from '../components/SaveBar.tsx';
import { thisComputer } from '../platform.ts';
import { SettingHeading, SettingSection } from '../components/SettingHelp.tsx';
import { Archive, Bot, GitBranch, Plug, SlidersHorizontal, Workflow as Workflow2, FolderGit2, Keyboard, Layers, Palette, Bell, TerminalSquare, Shield, Eye, SwatchBook, Ticket } from 'lucide-react';
import { ArchivedSettings } from './ArchivedSettings.tsx';
import { SetupSetting } from '../onboarding/SetupSetting.tsx';
import { CreateProjectPage } from './CreateProjectPage.tsx';
import { ComposerControls } from '../components/ComposerControls.tsx';
import { ProjectSetup } from '../components/ProjectSetup.tsx';
import { TagSuggestionSettings } from '../components/TagSuggestionSettings.tsx';
import { ProjectEditsSetting } from '../components/ProjectEditsSetting.tsx';
import { CommandsKeptSetting } from '../components/CommandsKeptSetting.tsx';
import { AppearanceSetting } from '../components/AppearanceSetting.tsx';
import { ColoursSetting } from '../components/ColoursSetting.tsx';
import { ShortcutsSetting } from '../components/ShortcutsSetting.tsx';
import { PresetsSetting } from '../components/PresetsSetting.tsx';
import { CodeReviewsSettings } from '../components/ReviewRequestsSetting.tsx';
import { CleanupPolicySetting } from '../components/CleanupPolicySetting.tsx';
import { KeepAwakeSetting } from '../components/KeepAwakeSetting.tsx';
import { NotificationsSetting } from '../components/NotificationsSetting.tsx';
import { GlobalEnvSetting } from '../components/EnvSetting.tsx';
import { OpenInSetting } from '../components/OpenInSetting.tsx';
import { SandboxAllowSetting } from '../components/SandboxAllowSetting.tsx';
import { DelegationLimitsSetting } from '../components/DelegationLimitsSetting.tsx';
import { CommitSigningSetting } from '../components/CommitSigningSetting.tsx';
import { CrashReportsSetting } from '../components/CrashReportsSetting.tsx';
import { KestrelConnectSetting } from '../components/KestrelConnectSetting.tsx';
import { ConnectPairPage } from '../components/ConnectPairPage.tsx';
import { WorktreesSetting } from '../components/WorktreesSetting.tsx';
import { SessionOrderSetting } from '../components/SessionOrderSetting.tsx';
import { BranchPrefixSetting } from '../components/BranchPrefixSetting.tsx';
import { StartFromLatestSetting } from '../components/StartFromLatestSetting.tsx';
import { ConnectionList } from '../components/StatusArea.tsx';
import { useConnections } from '../components/useAgents.ts';
import { opener, openView } from '../route.ts';
import { START_FROM, START_FROM_LABEL } from '@kestrel/server/sticky-controls';
import { startingControls, startingFrom, tabActions, useTabs } from '../tabsStore.ts';

function General() {
  const defaults = useTabs(startingControls);
  const from = useTabs(startingFrom);
  return (
    <>
      <h1>General</h1>
      <SettingSection title="New sessions start with" help={<p className="settings-help">"{START_FROM_LABEL.last}" follows your choices: the agent, model and effort you last picked, here or in any session. "{START_FROM_LABEL.fixed}" starts every new session on the agent, model, effort and project set here (or with no project), whatever you used last; pick one of your presets from Preset, or set them one by one. With "{START_FROM_LABEL.last}" the project follows the last used too. Either way the mode follows the last used, a new session opened from a project or group uses that project or group, and you can still change any of it before you send.</p>}>
        <div className="settings-choices" role="radiogroup" aria-label="New sessions start with">
          {START_FROM.map((choice) => (
            <label key={choice} className="settings-choice">
              <input type="radio" name="start-from" checked={from === choice} onChange={() => tabActions.setStartFrom(choice)} />
              {START_FROM_LABEL[choice]}
            </label>
          ))}
        </div>
        <div className="settings-defaults">
          <ComposerControls value={defaults} mode="new" onChange={tabActions.setDefaults} />
        </div>
      </SettingSection>
      <SessionOrderSetting />
      <OpenInSetting />
      <KeepAwakeSetting />
      <SetupSetting />
      <CrashReportsSetting />
      {window.kestrelShell?.app && (
        <section className="settings-section">
          <h2>About</h2>
          <p className="settings-version">
            Kestrel {window.kestrelShell.app.version}
            {window.kestrelShell.app.packaged ? '' : ' (run from a checkout)'}. Check for updates from the Kestrel menu.
          </p>
        </section>
      )}
    </>
  );
}

const MCP_HELP = (
  <p className="settings-help">MCP servers are found in Claude Code, the Claude desktop app, Codex and OpenCode. A server set up for one project only appears on that project's Settings tab. Their tools still ask before they run, at the session's permission level.</p>
);

/** The defaults every project follows: set once here, overridden per project only when needed. */
function AgentSetup() {
  return (
    <>
      <SettingHeading
        level={1}
        title="Agent setup"
        help={<p className="settings-help">What every session gets from your own agent setup, in every project and with no project. Set it once here. A project can be given its own setup on its Settings tab. Changes apply to sessions started from now on.</p>}
      />
      <section className="settings-section wide">
        <ProjectSetup mcpHelp={MCP_HELP} />
      </section>
    </>
  );
}

/** How Kestrel names the branches of new sessions in git projects, and where they start. */
function Git() {
  return (
    <>
      <h1>Git</h1>
      <BranchPrefixSetting />
      <StartFromLatestSetting />
      <CleanupPolicySetting />
    </>
  );
}

/** How Kestrel itself behaves around sessions: where changes are made, and what it suggests. One section, not one each. */
function Workflow() {
  return (
    <>
      <h1>Workflow</h1>
      <ProjectEditsSetting />
      <DelegationLimitsSetting />
      <CommandsKeptSetting />
      <TagSuggestionSettings />
    </>
  );
}

function Connections() {
  const { rows } = useConnections();
  return (
    <>
      <SettingHeading level={1} title="Connections" help={<p className="settings-help">What Kestrel is connected to on {thisComputer()}.</p>} />
      <KestrelConnectSetting />
      <section className="settings-section connections-services">
        <h2>Agents & services</h2>
        <ConnectionList rows={rows} />
      </section>
    </>
  );
}

/** Sections that were renamed: an old link or an open tab still lands on the right one. */
const RENAMED: Record<string, string> = { 'tag-suggestions': 'workflow' };

export function SettingsPage({ section: asked = 'general' }: { section?: string }) {
  const section = RENAMED[asked] ?? asked;
  const item = (id: string, label: string, icon: React.ReactNode) => (
    <button key={id} className={`side-link${section.split('/')[0] === id ? ' active' : ''}`} aria-current={section.split('/')[0] === id ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'settings', section: id }, newTab))}>
      {icon}
      <span className="link-label">{label}</span>
    </button>
  );
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        <div className="settings-nav-group">Personal</div>
        {item('general', 'General', <SlidersHorizontal aria-hidden />)}
        {item('appearance', 'Appearance', <Palette aria-hidden />)}
        {item('colours', 'Colours', <SwatchBook aria-hidden />)}
        {item('notifications', 'Notifications', <Bell aria-hidden />)}
        {item('shortcuts', 'Keyboard shortcuts', <Keyboard aria-hidden />)}
        <div className="settings-nav-group">Agents</div>
        {item('presets', 'Models & roles', <Layers aria-hidden />)}
        {item('workflow', 'Workflow', <Workflow2 aria-hidden />)}
        {item('agent-setup', 'Agent setup', <Bot aria-hidden />)}
        {item('environment', 'Environment', <TerminalSquare aria-hidden />)}
        {item('permissions', 'Permissions', <Shield aria-hidden />)}
        <div className="settings-nav-group">Workspace</div>
        {item('git', 'Git', <GitBranch aria-hidden />)}
        {item('code-reviews', 'Code reviews', <Eye aria-hidden />)}
        {item('tickets', 'Tickets', <Ticket aria-hidden />)}
        {item('connections', 'Connections', <Plug aria-hidden />)}
        {item('worktrees', 'Storage', <FolderGit2 aria-hidden />)}
        {item('archived', 'Archived', <Archive aria-hidden />)}
      </nav>
      <div className="settings-main">
      <div className={`settings-body settings-${section.replaceAll('/', '-')}`} key={section}>
        {section === 'appearance' ? (
          <AppearanceSetting page />
        ) : section === 'colours' ? (
          <ColoursSetting />
        ) : section === 'notifications' ? (
          <NotificationsSetting page />
        ) : section === 'environment' ? (
          <GlobalEnvSetting page />
        ) : section === 'permissions' ? (
          <>
            <h1>Permissions</h1>
            <SandboxAllowSetting />
            <CommitSigningSetting />
          </>
        ) : section === 'presets' ? (
          <PresetsSetting />
        ) : section === 'shortcuts' ? (
          <ShortcutsSetting />
        ) : section === 'agent-setup' ? (
          <AgentSetup />
        ) : section === 'git' ? (
          <Git />
        ) : section === 'code-reviews' ? (
          <CodeReviewsSettings />
        ) : section === 'tickets' ? (
          <TicketsSettings />
        ) : section === 'workflow' ? (
          <Workflow />
        ) : section === 'connections' ? (
          <Connections />
        ) : section === 'connections/pair' ? (
          <ConnectPairPage />
        ) : section === 'archived' ? (
          <ArchivedSettings />
        ) : section === 'worktrees' ? (
          <WorktreesSetting />
        ) : section === 'add-project' ? (
          <CreateProjectPage />
        ) : (
          <General />
        )}
      </div>
      <SaveBar watch={section} />
      </div>
    </div>
  );
}
