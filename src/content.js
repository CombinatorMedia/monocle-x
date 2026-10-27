/**
 * Entry point: intercepts clicks on X media tiles and opens our viewer instead
 * of X's lightbox.
 *
 * Why this exists at all — measured on x.com 2026-10-26: X's media lightbox
 * has no cross-tweet navigation. Pressing ArrowRight in it changed neither the
 * URL nor the image, and its controls offer Close but no next/prev. To see the
 * next result you must close and reopen. This restores the keyboard.
 *
 * ── HARDENING ──────────────────────────────────────────────────────────────
 * FAIL SILENT, NEVER FAIL LOUD. Every path here is written so that when we
 * can't do the job, X does it instead. If no record matches the clicked tile,
 * we don't preventDefault, and X's own lightbox opens exactly as before. A
 * broken extension should look like an absent extension, not a broken X.
 */
(function () {
  'use strict';

  let domFallbackTried = false;

  function ensureRecords() {
    const api = window.MonocleX;
    if (!api) return 0;
    if (api.results().length === 0 && !domFallbackTried) {
      // Network path produced nothing — try to recover photos from the DOM
      // before giving the click back to X.
      domFallbackTried = true;
      api.harvestFromDom();
    }
    return api.results().length;
  }

  // Capture phase, so we see the click before X's router does. Verified live:
  // preventDefault here suppresses X's navigation entirely.
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let people open tabs
      const api = window.MonocleX;
      if (!api) return;

      const tile = api.tileFromEvent(e);
      if (!tile) return;

      ensureRecords();
      const index = api.indexForHref(tile.href);
      if (index === -1) return; // unknown tile — hand it back to X untouched

      e.preventDefault();
      e.stopImmediatePropagation();

      const img = tile.element.querySelector('img');
      const rect = (img || tile.element).getBoundingClientRect();
      window.MonocleXOverlay.open(api.results(), index, rect);
    },
    true
  );

  // Keep the viewer's list growing while it's open: X loads more timeline
  // pages as the user (or our own prefetch) scrolls, and each batch arrives
  // through page-data.js.
  window.addEventListener('monoclex:records', () => {
    const overlay = window.MonocleXOverlay;
    if (!overlay || !overlay.root || overlay.root.hidden) return;
    overlay.syncResults(window.MonocleX.results());
  });

  // The grid is virtualised and X only fetches more when it thinks you're
  // near the bottom. When the viewer approaches the end of what we know, nudge
  // the underlying page so the next batch arrives before you reach it.
  window.addEventListener('monoclex:needmore', () => {
    const doc = document.scrollingElement || document.documentElement;
    doc.scrollTop = Math.min(doc.scrollTop + window.innerHeight * 2, doc.scrollHeight);
  });

  // Toolbar click opens the viewer at the first known item, so the extension
  // is reachable even if a click interception ever stops matching.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'mx-open-toolbar') return;
    if (!ensureRecords()) return;
    window.MonocleXOverlay.open(window.MonocleX.results(), 0);
  });

  // Diagnostics, for when X eventually changes something and you want to know
  // which half broke: run window.__monocleX() in the console on x.com.
  window.__monocleX = () => ({
    scraper: window.MonocleX ? window.MonocleX.health() : 'scraper not loaded',
    overlayMounted: !!(window.MonocleXOverlay && window.MonocleXOverlay.root),
  });
})();
