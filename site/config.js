/*
 * RiftSight site — public link, CTA & status configuration.
 *
 * This is the ONE place to edit outward-facing URLs and beta copy. site.js
 * reads this at load time and wires the pages from data-attributes:
 *
 *   - [data-link="key"] gets its href from links[key]; if null, the element
 *     (and anything marked data-requires="key") is removed — an unconfigured
 *     link never renders as a dead button.
 *   - The primary CTA, streamer-access gate, extension install button, demo
 *     video and setup video are all driven from the fields below.
 *
 * No secrets belong in this file — it ships to the browser as-is.
 */
window.RIFTSIGHT_CONFIG = {
  // Canonical public domain (visible copy / metadata live at this host).
  domain: "riftsight.gg",

  // ---- Public links -------------------------------------------------------
  links: {
    // Source code. Repo remote today is github.com/ryangswe/RiftSight.
    github: "https://github.com/ryangswe/RiftSight",

    // Internal streamer setup/onboarding page (the primary CTA target).
    setup: "./setup.html",

    // Temporary streamer-access gate: the Google Form we manually review
    // during the early beta allowlist. Remove the gate (see setup.html) once
    // streamer onboarding becomes fully open/self-service.
    streamerForm: "https://docs.google.com/forms/d/11h1xxnj0oEG12t8qde-a37nQxFkwaSj04fd5DBb54_8/viewform",

    // How the Chrome extension is distributed. While the Web Store listing is
    // in review, we ship a downloadable ZIP hosted on the site. When the store
    // listing is approved, set `chromeWebStore` and the install button on the
    // setup page automatically becomes an "Add to Chrome" button — no redesign.
    extensionZip: "./assets/riftsight-extension.zip",
    chromeWebStore: null,
    twitchExtension: null,

    // Community & support.
    discord: "https://discord.gg/BDneXFqhy",
    x: "https://x.com/RiftSight?s=20",
    support: null, // e.g. a Ko-fi / GitHub Sponsors URL

    // Contact + legal. These ship alongside the site, so they always resolve.
    supportEmail: "mailto:riftsight.support@gmail.com",
    privacy: "./privacy.html",
    terms: "./eula.html",

    // Reference only (used in copy, not a CTA).
    riftatlas: "https://riftatlas.com",
  },

  // ---- Primary call-to-action --------------------------------------------
  // Streamer-facing: viewers don't need to join anything, so the primary CTA
  // sends streamers to the setup page. When streamer access opens fully you
  // may change the label to "Set up RiftSight" — nothing else needs to move.
  primaryCta: {
    label: "Stream with RiftSight",
    href: "./setup.html",
  },

  // ---- Product demo media -------------------------------------------------
  // Set `video` (an .mp4/.webm URL in ./assets/) to replace the CSS mockup
  // with a muted, autoplaying, looping, controls-free <video>. It swaps every
  // [data-demo] container EXCEPT any marked data-demo-static — the "See it in
  // action" showcase is marked static, so this drives the hero only. Remove
  // that attribute in index.html to use the same clip in the showcase too.
  demo: {
    video: "./assets/demo.mp4",
    poster: null,
  },

  // ---- Setup page ---------------------------------------------------------
  // `video` is the embed URL for the "Watch the setup" walkthrough. Use a
  // YouTube *embed* URL, e.g. "https://www.youtube.com/embed/VIDEO_ID".
  // Until it's set, a styled placeholder shows and the written guide carries
  // the page on its own.
  setup: {
    video: null,
  },

  // ---- Beta / availability band ------------------------------------------
  // Set `show` to false to hide the section entirely. When the streamer
  // allowlist is removed, the main edit here is `message`/`note`.
  status: {
    show: true,
    label: "Beta",
    heading: "RiftSight is now available on Twitch.",
    message:
      "Viewers can use RiftSight on any supported stream. We're gradually onboarding Rift Atlas streamers while we monitor reliability and scale up.",
    note: "Streamer access may require approval during the beta.",
  },
};
