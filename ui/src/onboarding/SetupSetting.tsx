import { SettingHeading } from '../components/SettingHelp.tsx';
import { useState } from 'react';
import { reasonOf } from '@kestrel/server/sourced';
import { openView } from '../route.ts';
import { saveSetup } from './data.ts';

export function SetupSetting() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true); setError(null);
    try { await saveSetup('welcome'); openView({ kind: 'overview' }); }
    catch (e) { setError(reasonOf(e)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section"><SettingHeading title="Welcome to Kestrel" label="Setup guide" help={<p className="settings-help">Check your agents and add projects with the setup guide.</p>} /><button className="secondary-button" disabled={busy} onClick={() => void start()}>{busy ? 'Opening…' : 'Run setup'}</button>{error && <p className="field-error" role="alert">{error}</p>}</section>;
}
