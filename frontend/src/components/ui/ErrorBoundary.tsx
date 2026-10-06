import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './States';

/**
 * Catches a render-time throw and shows a recoverable error instead of a blank
 * page.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Until this existed, one bad value in one component unmounted the entire
 * application. That is not hypothetical: `ExportsPage` read
 * `queryKey: ['academic-years']`, a key another component had already populated
 * with an object rather than an array, called `.map` on it, and threw. Because
 * there was no boundary anywhere above it, React tore down the whole tree — the
 * navigation, the breadcrumb, everything — and left `#root` empty. The user was
 * left staring at a white page with no way out except a browser refresh.
 *
 * Two properties matter more than "it shows an error":
 *
 *  - It is mounted **inside** `AppLayout`, around the `<Outlet />`, so the shell
 *    survives. Navigation still works, so the mistake costs one page rather
 *    than the session.
 *  - It clears itself when `resetKey` changes. Without that, a page that threw
 *    once stays broken for the rest of the session: React remembers the failed
 *    state and re-renders nothing. Keying on the pathname means navigating away
 *    and back genuinely re-mounts it.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Changing this value clears a captured error. Pass the current pathname.
   */
  resetKey?: string;
  /** Where the failure came from, for the message. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than swallowed: the component stack is the only
    // thing that makes a render crash diagnosable after the fact.
    console.error('[ErrorBoundary]', this.props.label ?? 'render', error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorState
        title={this.props.label ? `${this.props.label} could not be displayed` : 'Something went wrong'}
        message={error.message || 'An unexpected error stopped this page from rendering.'}
        hint="The rest of the app still works — use the navigation to go somewhere else, or try again."
        onRetry={this.retry}
      />
    );
  }
}