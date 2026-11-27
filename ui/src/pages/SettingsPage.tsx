// Settings, in the main canvas: a list of sections on the left, the chosen one on the right. App-wide
// only: a project's own settings are on its page's Settings tab. Nothing opens in a panel from the side.
import { PlanUsageOverview } from '../components/controls/PlanUsage.tsx';
import type { SettingsSection } from '@kestrel/server/routes';
import { useEffect } from 'react';
import { TicketsSettings } from '../components/TicketsSetting.tsx';
import { SaveBar } from '../components/SaveBar.tsx';
import { thisComputer } from '../platform.ts';
import { SettingHeading, SettingSection } from '../components/SettingHelp.tsx';
import { Archive, Bot, GitBranch, ListChecks, Plug, SlidersHorizontal, Workflow as Workflow2, FolderGit2, Keyboard, Layers, Palette, Bell, TerminalSquare, Shield, Eye, SwatchBook, Ticket } from 'lucide-react';
import { ArchivedSettings } from './ArchivedSettings.tsx';
import { SetupSetting } from '../onboarding/SetupSetting.tsx';
import { CreateProjectPage } from './CreateProjectPage.tsx';
import { ComposerControls } from '../components/ComposerControls.tsx';
import { ProjectSetup } from '../components/ProjectSetup.tsx';
import { McpServersSetting } from '../components/McpServers.tsx';
import { McpServerPage } from './McpServerPage.tsx';
import { TagSuggestionSettings } from '../components/TagSuggestionSettings.tsx';
import { ProjectEditsSetting } from '../components/ProjectEditsSetting.tsx';
import { KnowledgeSetting } from '../components/KnowledgeSetting.tsx';
import { RemoteStartsSetting } from '../components/RemoteStartsSetting.tsx';
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
import { UpdateChannelSetting } from '../components/UpdateChannelSetting.tsx';
import { WhatsNewSetting } from '../components/WhatsNewSetting.tsx';
import { KestrelConnectSetting } from '../components/KestrelConnectSetting.tsx';
import { ConnectRecoveryPage } from '../components/ConnectRecoveryPage.tsx';
import { SetupThisComputerPage } from '../components/SetupThisComputerPage.tsx';
import { setupLeftText, setupRecordRefresh, useSetupLeft } from '../setupList.ts';
import { ValuesSentList } from '../components/SetupValueRequests.tsx';
import { WorktreesSetting } from '../components/WorktreesSetting.tsx';
import { SessionOrderSetting } from '../components/SessionOrderSetting.tsx';
import { BranchPrefixSetting } from '../components/BranchPrefixSetting.tsx';
import { PullRequestsNeedYouSetting } from '../components/PullRequestsNeedYouSetting.tsx';
import { AutopilotSetting } from '../components/AutopilotSetting.tsx';
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
          <ComposerControls value={defaults} mode="new" computers={false} onChange={tabActions.setDefaults} />
        </div>
      </SettingSection>
      <SessionOrderSetting />
      <OpenInSetting />
      <KeepAwakeSetting />
      <SetupSetting />
      <CrashReportsSetting />
      <UpdateChannelSetting />
      <WhatsNewSetting />
    </>
  );
}

const MCP_HELP = (
  <p className="settings-help">Kestrel's own servers for every project come first; the rest are found in Claude Code, the Claude desktop app, Codex and OpenCode. Where a name is in both, Kestrel's is used. A server set up for one project only appears on that project's Settings tab. Their tools still ask before they run, at the session's permission level.</p>
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
      <SettingSection title="Plan usage" help={<p className="settings-help">How much of each agent account's plan is used, as the agent itself reports it: Claude and Codex report their limit windows while a turn runs (and Codex once when it starts), so the figures are as of the last turn. OpenCode reports no plan limits; its cost and tokens are shown for each session. The same figures are under the message box. Kestrel never asks a provider itself.</p>}>
        <PlanUsageOverview />
      </SettingSection>
      <McpServersSetting />
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
      <PullRequestsNeedYouSetting />
      <AutopilotSetting />
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
      <KnowledgeSetting />
      <RemoteStartsSetting />
    </>
  );
}

function Connections() {
  const { rows } = useConnections();
  // Opening Connections writes this computer's set-up record again if it changed (onboarding.md, section 3).
  useEffect(() => setupRecordRefresh(), []);
  return (
    <>
      <SettingHeading level={1} title="Connections" help={<p className="settings-help">What Kestrel is connected to on {thisComputer()}.</p>} />
      <KestrelConnectSetting />
      <section className="settings-section connections-services">
        <h2>Agents & services</h2>
        <ConnectionList rows={rows} />
      </section>
      <ValuesSentList />
    </>
  );
}

/** Sections that were renamed: an old link or an open tab still lands on the right one. */
/** Every section's name and icon. A Record over SETTINGS_SECTIONS (shared/routes.ts), so the list release notes may link to and this page cannot differ. */
const SECTION_NAV: Record<SettingsSection, { label: string; icon: React.ReactNode }> = {
  'general': { label: 'General', icon: <SlidersHorizontal aria-hidden /> },
  'appearance': { label: 'Appearance', icon: <Palette aria-hidden /> },
  'colours': { label: 'Colours', icon: <SwatchBook aria-hidden /> },
  'notifications': { label: 'Notifications', icon: <Bell aria-hidden /> },
  'shortcuts': { label: 'Keyboard shortcuts', icon: <Keyboard aria-hidden /> },
  'presets': { label: 'Models & roles', icon: <Layers aria-hidden /> },
  'workflow': { label: 'Workflow', icon: <Workflow2 aria-hidden /> },
  'agent-setup': { label: 'Agent setup', icon: <Bot aria-hidden /> },
  'environment': { label: 'Environment', icon: <TerminalSquare aria-hidden /> },
  'permissions': { label: 'Permissions', icon: <Shield aria-hidden /> },
  'git': { label: 'Git', icon: <GitBranch aria-hidden /> },
  'code-reviews': { label: 'Code reviews', icon: <Eye aria-hidden /> },
  'tickets': { label: 'Tickets', icon: <Ticket aria-hidden /> },
  'connections': { label: 'Connections', icon: <Plug aria-hidden /> },
  'worktrees': { label: 'Storage', icon: <FolderGit2 aria-hidden /> },
  'archived': { label: 'Archived', icon: <Archive aria-hidden /> },
};

const RENAMED: Record<string, string> = { 'tag-suggestions': 'workflow' };

export function SettingsPage({ section: asked = 'general' }: { section?: string }) {
  const section = RENAMED[asked] ?? asked;
  const setupLeftCount = useSetupLeft();
  const item = (id: SettingsSection) => (
    <button key={id} className={`side-link${section.split('/')[0] === id ? ' active' : ''}`} aria-current={section.split('/')[0] === id ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'settings', section: id }, newTab))}>
      {SECTION_NAV[id].icon}
      <span className="link-label">{SECTION_NAV[id].label}</span>
    </button>
  );
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {setupLeftCount > 0 && (
          <button className={`side-link${section === 'connections/setup' ? ' active' : ''}`} aria-current={section === 'connections/setup' ? 'page' : undefined} {...opener((newTab) => openView({ kind: 'settings', section: 'connections/setup' }, newTab))}>
            <ListChecks aria-hidden />
            <span className="link-label">Finish set up</span>
            <span className="setup-left" aria-label={setupLeftText(setupLeftCount)} title={setupLeftText(setupLeftCount)}>{setupLeftCount}</span>
          </button>
        )}
        <div className="settings-nav-group">Personal</div>
        {item('general')}
        {item('appearance')}
        {item('colours')}
        {item('notifications')}
        {item('shortcuts')}
        <div className="settings-nav-group">Agents</div>
        {item('presets')}
        {item('workflow')}
        {item('agent-setup')}
        {item('environment')}
        {item('permissions')}
        <div className="settings-nav-group">Workspace</div>
        {item('git')}
        {item('code-reviews')}
        {item('tickets')}
        {item('connections')}
        {item('worktrees')}
        {item('archived')}
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
        ) : section.startsWith('agent-setup/mcp/') ? (
          <McpServerPage name={section.split('/')[2] ?? 'new'} projectId={section.split('/')[3] ?? ''} />
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
        ) : section === 'connections/recovery' ? (
          <ConnectRecoveryPage />
        ) : section === 'connections/setup' ? (
          <SetupThisComputerPage />
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
