/**
 * Builds an absolute URL for redirects that leave React Router's control.
 *
 * Clerk performs these navigations itself, so it never sees the router's
 * `basename`. A bare `/` would resolve against the *origin* root — on GitHub
 * Pages that is `https://<user>.github.io/`, which is a 404 because the app
 * lives under `/school-marks/`. Prefixing with `VITE_APP_ORIGIN` (the app
 * root: origin **plus** base path) sends Clerk back into the app instead.
 *
 * `VITE_APP_ORIGIN` deliberately carries the base path, unlike Clerk's
 * *Allowed Origins* setting (dashboard), which takes the origin only.
 */
export function buildUrl(path: string): string {
  const origin = import.meta.env.VITE_APP_ORIGIN;
  return origin ? `${origin}${path}` : path;
}
