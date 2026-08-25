# Docxy marketing site

The public landing page for [Docxy](../README.md), the multi-agent
documentation-and-changelog pipeline in the parent directory.

Next.js 16 (App Router, Turbopack) · React 19 · Tailwind CSS v4 · TypeScript.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static prerender of /
```

## Where things live

```
src/
  app/layout.tsx        fonts, metadata, the html shell
  app/page.tsx          section order, the whole page in one file
  app/globals.css       palette tokens and the .rule-h / .rule-v hairlines
  lib/site.ts           every string on the page
  components/
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
