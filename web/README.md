# Docxy web

The landing page and the operator dashboard for [Docxy](../README.md), the
multi-agent documentation-and-changelog pipeline in the parent directory.

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS v4 · TypeScript ·
Better Auth on Neon Postgres via Drizzle.

```bash
npm install
cp .env.local.example .env.local   # then fill in DATABASE_URL and BETTER_AUTH_SECRET
npm run db:migrate                 # create the auth schema
npm run dev                        # http://localhost:3000
npm run build
```

`/` is static and needs no configuration at all. `/dashboard` and `/login` need
the database.

## Sign-in

Three ways in, all through Better Auth: email and password, Google, and GitHub.
Email and password always works; each social button appears only once that
provider's credentials are set, because an OAuth button that can only fail is
worse than no button.

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Neon pooled connection string, shared with the pipeline |
| `BETTER_AUTH_SECRET` | yes | session signing key: `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | behind a proxy | public origin, for OAuth callback URLs |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | enables the Google button |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | enables the GitHub button |
| `DOCXY_API_URL` | no | where the pipeline API lives, default `http://localhost:4317` |
| `DOCXY_REQUIRE_AUTH` | no | set to `0` to open the dashboard unauthenticated, for demos |

OAuth callback URLs are `/api/auth/callback/google` and
`/api/auth/callback/github`.

Missing either required variable, `/login` says which one rather than presenting
a form that cannot work.

### How the gate is arranged

`src/proxy.ts` checks only that a session cookie is *present* on `/dashboard`.
It runs on every navigation, so a database round trip there would tax each one.
The authoritative check is `getSessionUser` in the dashboard layout, and the
`/api/docxy/*` pass-through checks separately — the endpoints behind it approve
runs and open pull requests, so it cannot inherit trust from the page that
called it.

Better Auth's tables live in a dedicated `auth` Postgres schema, kept apart from
the pipeline's own tables in `public`. See [guides/DATABASE.md](../guides/DATABASE.md).

## Where things live

```
src/
  app/layout.tsx        fonts, metadata, the html shell
  app/page.tsx          section order, the whole landing page in one file
  app/globals.css       palette tokens and the .rule-h / .rule-v hairlines
  app/login/page.tsx    sign-in, or the missing-configuration checklist
  app/dashboard/        the operator views, all force-dynamic
  app/api/auth/[...all] every Better Auth endpoint
  app/api/docxy/        authenticated pass-through to the pipeline API
  proxy.ts              the optimistic cookie gate on /dashboard
  db/schema.ts          Better Auth's tables, in the `auth` schema
  db/index.ts           the Neon connection
  lib/auth.ts           Better Auth server config
  lib/auth-client.ts    the browser client
  lib/env.ts            what is configured, readable without a database
  lib/site.ts           every string on the landing page
  components/
    auth/               SignInPanel and the provider marks
    dashboard/          Sidebar, panels, and the run timeline
    primitives.tsx      Rule, SideRails, Section, SectionHead, ButtonLink, CellGrid
    Navbar.tsx          top banner + sticky nav
    Hero.tsx            headline and the GitHub Actions run mock
    Sections.tsx        Quote, Why, HowItWorks, Roster, Integrations
    Approval.tsx        the interactive approval-gate mock
    Setup.tsx           Setup + Cost
    Faq.tsx             accordion
    Footer.tsx
    icons.tsx           brand marks for the integration tiles
    Logo.tsx            LogoMark and Wordmark, used by nav, quote, footer
  app/icon.png          browser tab icon, generated from the logo
  app/apple-icon.png    iOS home screen icon, generated from the logo
public/logo.png         the original logo, untouched
public/logo-mark.png    despeckled and trimmed, this is what the page renders
public/brand/           Nebius and TrueForge favicons, vendored
```

## Design notes

The page commits to a single light look, with no dark-mode variant. The visual
system is three things:

- **Dashed hairlines.** `.rule-h` separates every section and bleeds past the
  section padding; `.rule-v` runs two vertical rails down the page gutters,
  pinned to `max(2rem, calc((100% - 80rem) / 2))`.
- **Hairline-gapped grids.** `CellGrid` puts white cells on a `bg-zinc-200`
  field with `gap-px`, so the 1px gaps read as rules rather than borders.
- **One accent.** `--accent` is sampled from the logo (`#2179fc`), so the page
  and the icon agree. `--accent-deep` is the same hue darkened to 6.3:1 on
  white, used anywhere small white text sits on blue (the top banner), because
  the logo blue itself only reaches 4.0:1 and would fail AA there. Changing
  those two values re-themes the page.

Copy lives in `src/lib/site.ts` so wording changes never mean touching layout.

## Editing content

Most changes are a `site.ts` edit: `why`, `roles`, `validations`,
`integrations`, and `faqs` are plain arrays that drive their sections. Adding an
integration also needs a matching entry in `components/icons.tsx`, keyed by the
same `name`.

Brand marks come from `react-icons/si` (Simple Icons). Nebius and TrueForge have
no Simple Icons entry, so their own favicons are vendored under `public/brand`
rather than hotlinked, which keeps the page working offline and stops a remote
404 from leaving a hole in the grid.

House style for copy: no em dashes anywhere, second person, short sentences.

## Logo assets

`public/logo.png` is the original, left exactly as supplied. Everything else is
derived from it and can be regenerated:

- `public/logo-mark.png` is the same image with near-transparent speckle
  stripped (about 10k stray pixels) and cropped to the mark itself. The original
  sits in a 1254px square canvas with roughly 19% padding, which made it render
  small and off-centre next to the wordmark at 28px.
- `src/app/icon.png` (512px) and `src/app/apple-icon.png` (180px) are square
  versions for the browser tab and iOS home screen. The Apple one gets a white
  ground because iOS composites transparent icons onto black.

If you replace the logo, drop the new file at `public/logo.png` and rebuild
these three. Resample `--accent` from it too if the blue shifts.
