// When the page fails to draw, say so and say why. Without this a failure anywhere in the UI
// leaves an empty window with nothing to go on.
import { Component, type ErrorInfo, type ReactNode } from 'react';

type Failure = { error: Error; where: string };

const details = (f: Failure) => [`${f.error.name}: ${f.error.message}`, '', f.error.stack ?? '(no stack)', '', 'Component stack:', f.where.trim() || '(none)'].join('\n');

/** The first component named in React's component stack: where the failure happened, in words a person can use. */
export const failedIn = (componentStack: string): string => /^\s*at (\w+)/m.exec(componentStack)?.[1] ?? '';

export class CrashBoundary extends Component<{ children: ReactNode }, { failure: Failure | null; copied: boolean }> {
  state: { failure: Failure | null; copied: boolean } = { failure: null, copied: false };

  static getDerivedStateFromError(error: unknown) {
    return { failure: { error: error instanceof Error ? error : new Error(String(error)), where: '' } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[kestrel] the page failed to draw', error, info.componentStack);
    this.setState({ failure: { error: error instanceof Error ? error : new Error(String(error)), where: info.componentStack ?? '' } });
  }

  private copy = async () => {
    if (!this.state.failure) return;
    await navigator.clipboard.writeText(details(this.state.failure)).catch(() => undefined);
    this.setState({ copied: true });
  };

  render() {
    const { failure, copied } = this.state;
    if (!failure) return this.props.children;
    const component = failedIn(failure.where);
    return (
      <div className="kestrel crash" role="alert">
        <div className="crash-drag" />
        <div className="crash-card">
          <h1>Kestrel could not draw this window</h1>
          <p className="crash-message">{failure.error.message || failure.error.name}</p>
          {component && <p className="crash-where">It failed in {component}.</p>}
          <p className="crash-hint">Your sessions are not affected: they run in the background. If this started after an update, quit and reopen Kestrel so its background server restarts too.</p>
          <div className="crash-actions">
            <button className="primary-button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button className="secondary-button" onClick={() => void this.copy()}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
          <details>
            <summary>Details</summary>
            <pre>{details(failure)}</pre>
          </details>
        </div>
      </div>
    );
  }
}
