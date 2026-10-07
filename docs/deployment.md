# Deployment

Where the app runs, what each pipeline does, and the one rule that has bitten
this repository twice.

## Live surfaces

| Surface | URL | Source |
| --- | --- | --- |
| Production | https://www.cccssj.cyou | Vercel (git-connected) |
| Vercel fallback | https://school-marks-liart.vercel.app | Vercel, same deployment |
| GitHub Pages | disabled | `.github/workflows/deploy.yml`, switched off |

The apex `cccssj.cyou` answers with a 308 redirect to `www`, and both domains
are verified on the Vercel project. DNS is served by `ns1/ns2.vercel-dns.com`,
so GitHub Pages no longer answers for the apex — the `cname` record that used to
point at `github.io` is kept only because it 301s the old `github.io` host to
the working custom domain.

The Pages workflow is **disabled rather than deleted**: it cannot run against
this repository on the current GitHub plan, and a disabled workflow stays
visible in the Actions tab without failing on every push.

## Which pipeline does what

- **Vercel** builds `frontend/` with `rootDirectory: frontend`. The base path
  resolves to `/` on Vercel and `/school-marks/` elsewhere (see
  `frontend/vite.config.ts`), and `vercel.json` — present at both the repo root
  and `frontend/`, because the project Root Directory could be either — rewrites
  unknown paths to `index.html` for client-side routes.
- **Local/CI** run `npm run typecheck`, `npm test`, `npm run build`. The build
  ends with `postbuild`, which writes `dist/404.html` for Pages SPA routing.
- **Emergency deploy**: `vercel deploy --prod` from a clean tree. This is what
  shipped the Three.js hero when the git push gate was closed (see below), and
  it remains the fallback whenever GitHub → Vercel is unavailable.

## The repository must stay public

This is the rule that has bitten twice, and it is not obvious from either
console.

The project sits on a **Hobby** team, and Vercel's own documentation is
explicit: *the Hobby plan does not support collaboration for private
repositories*, so before a deployment runs, Vercel must prove that the commit
author is the team owner. It resolves the commit author's email to a GitHub
account and compares that identity against the account connected under **Login
Connections**.

The commit author here is `Utkarsh <lgwebosutkarsh@gmail.com>`, which GitHub
maps to the account **`kanojiautkarsh-coder`** — not to
`kanojiaucnak-commits`, which owns this repository. While the repository was
private, every push therefore produced a deployment stuck in **Blocked**:

> The deployment was blocked because the commit author doesn't have permission
> to create deployments for this project.

Two fixes exist, and the repository uses the first:

1. **Keep the repository public.** Public repositories are exempt from the
   author check — "collaboration is free for public repositories". Every push
   deploys with no identity matching at all.
2. Connect `kanojiautkarsh-coder` under Vercel → Account Settings → Login
   Connections. This is the private-repo escape hatch, and it requires the
   GitHub account that owns the commit email, not the repository owner account.

Making the repository private also disabled GitHub Pages, because Pages on a
private repository requires a paid plan — the workflow began failing at
`actions/configure-pages` with `Get Pages site failed … Not Found`.

### If a deployment shows Blocked

Production keeps serving the last good deployment, so nothing goes down. To
ship anyway:

```
vercel deploy --prod
```

Then fix the underlying cause before the next push; do not leave the pipeline
on manual deploys.

## Environment

`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
are set on the Vercel project for both production and preview, and are inlined
into the bundle at build time — they are not secret, only the Supabase service
role key is, and it lives only in the Edge Function environment.

`VITE_APP_ORIGIN` is deliberately **unset** on Vercel: relative redirects work
on any domain, and pinning an origin there is how a custom-domain change turns
into a broken sign-in redirect.

## Things that are not deployed

- `VITE_SCHOOL_AFFILIATION` — never ship it; the school row is the source of
  truth.
- Clerk stays on publishable test keys (`pk_test_…`). Do not deploy a live
  `pk_live`/`sk_live` pair until signing in on the production domain has been
  verified end to end.
