import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';

/** 404. Also used for any route that exists but the current role cannot open. */
export default function NotFoundPage() {
  const location = useLocation();
  const { status } = useAuth();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-muted px-4 text-center">
      <p className="tabular text-6xl font-bold text-brand-200">404</p>
      <h1 className="mt-3 text-xl font-semibold text-ink">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-ink-muted">
        {location.pathname} does not exist. If you followed a link from inside the app, the page may
        have been renamed, or your role may not have access to it.
      </p>

      <div className="mt-6 flex gap-2">
        {status === 'authenticated' ? (
          <Link to="/app">
            <Button variant="primary">Back to the dashboard</Button>
          </Link>
        ) : (
          <Link to="/login">
            <Button variant="primary">Go to sign in</Button>
          </Link>
        )}
        <Button onClick={() => window.history.back()}>Go back</Button>
      </div>
    </div>
  );
}