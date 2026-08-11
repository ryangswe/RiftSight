# RiftSight site

A small, static, framework-free site for RiftSight — two pages (`index.html` and
`setup.html`) sharing one stylesheet and one script. No bundler, no CMS, no
backend. Canonical domain: **riftsight.gg**.

## Files

- `index.html` — the landing page.
- `setup.html` — the streamer onboarding + installation page (served at `/setup`).
- `site.css` — **all shared styles** for every page (design tokens mirror the
  Twitch config UI).
- `site.js` — **all shared runtime wiring** (reads `config.js`, drives links,
  CTAs, the demo/setup video swap, and the beta band from data-attributes).
- `config.js` — **the one place to edit** public URLs, CTA labels, and beta copy.
  See the comments in that file.
- `privacy.html` / `eula.html` — copies of the RiftSight Privacy Policy and Terms,
  shipped alongside the site so the footer links always resolve. Keep these in
  sync with `twitch-extension/privacy.html` and `twitch-extension/eula.html`
  (they are the source of truth).
- `assets/` — logo, favicons, the Open Graph image; also where the extension ZIP
  (`riftsight-extension.zip`), demo video, and `setup/` screenshots go.
- `build.mjs` — copies the static files into `dist/` (a deploy artifact + an
  integrity check). No transpiling happens.

## Editing links / CTAs

Everything outward-facing lives in `config.js`:

- Any link whose URL is `null` is **removed** from the page at load time, so an
  unconfigured link never renders as a dead button.
- `primaryCta` sets the streamer CTA label + target (default: "Stream with
  RiftSight" → `/setup`). Change the label to "Set up RiftSight" later in one line.
- `links.chromeWebStore` — when set, the setup page's install button becomes an
  "Add to Chrome" button; otherwise it offers `links.extensionZip`, and if
  neither is set it shows a "coming soon" placeholder. No markup changes needed.
- `links.streamerForm` — the "Request Streamer Access" gate on `/setup`.
- `setup.video` — a YouTube **embed** URL for the setup walkthrough (a styled
  placeholder shows until it's set). `demo.video` swaps the homepage mockups for
  a real muted/looping clip everywhere.
- `status.show: false` hides the beta band entirely; `status.*` is the beta copy.

## Removing the streamer allowlist later

When streamer onboarding opens fully: delete the `.access-card` block in
`setup.html` (marked `BETA ACCESS GATE`), tweak `status.message`/`note` in
`config.js`, and optionally change `primaryCta.label` to "Set up RiftSight". The
install steps already stand on their own.

## Local preview

```bash
npm run dev -w site       # serves at http://localhost:4321
```

or just open `index.html` in a browser.

## Deploy (Cloudflare Pages)

The rest of RiftSight already uses Cloudflare Pages (viewer hosting), so this
site fits the same account. Two equivalent options:

- **No build step:** point the Pages project at the `site/` directory, leave the
  build command empty.
- **With build:** Build command `npm run build`, output directory `site/dist`.

The site is fully static — no environment variables or secrets are required.
