/*
 * RiftSight site — shared runtime wiring for every page.
 *
 * Reads window.RIFTSIGHT_CONFIG (from config.js) and drives everything that
 * depends on outward-facing URLs or copy, entirely from data-attributes so the
 * markup stays declarative:
 *
 *   [data-link="key"]         → href from links[key]; removed if unset.
 *   [data-requires="key"]     → element removed entirely if links[key] unset.
 *   [data-cta="primary"]      → primaryCta.label + primaryCta.href (streamer CTA).
 *   [data-cta="request"]      → links.streamerForm (falls back to supportEmail).
 *   [data-cta="install"]      → chromeWebStore → extensionZip → "coming soon".
 *   [data-demo]               → swapped for a <video> when demo.video is set.
 *   [data-setup-video]        → YouTube (or other) iframe when setup.video is set.
 *   [data-status="…"]         → beta band label/heading/message/note.
 *
 * Nothing here is page-specific: each page only includes the elements it needs.
 */
(function () {
  var cfg = window.RIFTSIGHT_CONFIG || {};
  var links = cfg.links || {};

  function isSet(v) { return typeof v === "string" && v.length > 0; }
  function external(el, url) {
    if (/^https?:/i.test(url)) { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener noreferrer"); }
  }

  // Remove any element that depends on an unconfigured link.
  document.querySelectorAll("[data-requires]").forEach(function (el) {
    if (!isSet(links[el.getAttribute("data-requires")])) el.remove();
  });

  // Simple links; drop the element if its URL is missing.
  document.querySelectorAll("[data-link]").forEach(function (el) {
    var url = links[el.getAttribute("data-link")];
    if (isSet(url)) { el.setAttribute("href", url); external(el, url); }
    else el.remove();
  });

  // Primary streamer CTA (hero + beta band + header). Internal link to /setup
  // by default; label/href come from config so it is trivial to change later.
  var primary = cfg.primaryCta || {};
  document.querySelectorAll('[data-cta="primary"]').forEach(function (el) {
    if (isSet(primary.href)) el.setAttribute("href", primary.href);
    if (isSet(primary.label)) el.textContent = primary.label;
    if (isSet(primary.href)) external(el, primary.href);
  });

  // "Request Streamer Access" gate — the temporary allowlist form. Falls back
  // to the support email so it is never a dead button. Remove this whole
  // element from the page when the allowlist is dropped.
  document.querySelectorAll('[data-cta="request"]').forEach(function (el) {
    var href = isSet(links.streamerForm) ? links.streamerForm : links.supportEmail;
    if (isSet(href)) { el.setAttribute("href", href); external(el, href); }
    else el.remove();
  });

  // Extension install control (setup step 1). Prefer the Chrome Web Store once
  // approved; otherwise offer the ZIP download; otherwise show "coming soon".
  document.querySelectorAll('[data-cta="install"]').forEach(function (el) {
    if (isSet(links.chromeWebStore)) {
      el.setAttribute("href", links.chromeWebStore);
      el.textContent = el.getAttribute("data-label-store") || "Add to Chrome";
      external(el, links.chromeWebStore);
    } else if (isSet(links.extensionZip)) {
      el.setAttribute("href", links.extensionZip);
      el.textContent = el.getAttribute("data-label-zip") || "Download the extension (ZIP)";
      external(el, links.extensionZip);
    } else {
      // Replace the link with a non-interactive "coming soon" placeholder so
      // there is never a dead button.
      var soon = document.createElement("span");
      soon.className = "btn-soon";
      soon.innerHTML = '<span class="soon-tag">Soon</span> Chrome extension in review';
      el.replaceWith(soon);
    }
  });

  // Product demo: swap the CSS mockup for a real muted/looping video the moment
  // config.demo.video is set, in every [data-demo] container that isn't
  // explicitly marked data-demo-static (e.g. the showcase keeps its mockup).
  var demo = cfg.demo || {};
  if (isSet(demo.video)) {
    document.querySelectorAll("[data-demo]:not([data-demo-static])").forEach(function (el) {
      var v = document.createElement("video");
      v.muted = true; v.defaultMuted = true;
      v.autoplay = true; v.loop = true; v.playsInline = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.setAttribute("autoplay", ""); v.setAttribute("loop", "");
      v.preload = "metadata";
      v.className = "demo-video";
      if (isSet(demo.poster)) v.poster = demo.poster;
      var label = el.getAttribute("data-demo-label");
      if (label) v.setAttribute("aria-label", label);
      var src = document.createElement("source");
      src.src = demo.video;
      v.appendChild(src);
      el.replaceChildren(v);
      el.classList.add("has-video");
      var p = v.play && v.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    });
  }

  // Setup walkthrough video: inject an iframe embed when config.setup.video is
  // set; otherwise the styled placeholder in the markup stays.
  var setup = cfg.setup || {};
  if (isSet(setup.video)) {
    document.querySelectorAll("[data-setup-video]").forEach(function (el) {
      var frame = document.createElement("iframe");
      frame.src = setup.video;
      frame.title = "RiftSight setup walkthrough";
      frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("loading", "lazy");
      el.replaceChildren(frame);
    });
  }

  // Beta band copy (and hide the whole band if disabled).
  var status = cfg.status || {};
  if (status.show === false) {
    var band = document.getElementById("beta");
    if (band) band.remove();
  } else {
    var set = function (sel, val) { var n = document.querySelector(sel); if (n && isSet(val)) n.textContent = val; };
    set('[data-status="label"]', status.label);
    set('[data-status="heading"]', status.heading);
    set('[data-status="message"]', status.message);
    set('[data-status="note"]', status.note);
  }

  // Reveal the sticky header CTA only after the hero scrolls away (homepage).
  // Pages that want it always visible add `.pinned-cta` in markup instead.
  var header = document.querySelector(".site-header");
  if (header && !header.classList.contains("pinned-cta")) {
    var onScroll = function () { header.classList.toggle("scrolled", window.scrollY > 360); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
