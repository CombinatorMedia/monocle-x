/**
 * Builds the ordered list of media the viewer navigates, and resolves a
 * clicked grid tile to its record.
 *
 * ── HARDENING ──────────────────────────────────────────────────────────────
 * This file deliberately knows almost nothing about X's markup. The only DOM
 * contract it relies on is the permalink shape:
 *
 *     <a href="/<user>/status/<id>/photo/<n>">   (or /video/<n>)
 *
 * That URL is part of X's public surface — people paste it, it renders Open
 * Graph cards, it's indexed. It changes on a scale of years, where the class
 * names around it change weekly. So: no class selectors, no DOM structure
 * assumptions, no positional indexing. Tiles join to records by status id.
 *
 * SECOND SOURCE. If the GraphQL shape ever drifts far enough that page-data.js
 * returns nothing, harvestFromDom() independently recovers photos straight
 * from the <img> elements X has already rendered, upgrading their size
 * parameter to full resolution. Degraded (photos only, no video) but not dead.
 * Two independent paths that are unlikely to fail together.
 *
 * ORDERING. X's grid is virtualised — tiles recycle as you scroll, so DOM
 * order is only ever a window onto the real list. Measured live: tile count
 * went 45 → 46 → 37 → 34 → 78 → 81 while scrolling one search. The ordered
 * list therefore lives here, accumulated in arrival order from the network,
 * which is also timeline order. That's what lets the viewer walk past what is
 * currently rendered.
 */
(function (global) {
  'use strict';

  const CHANNEL = '__monocleXMedia';

  // status id -> [record, record, ...] (a tweet can carry up to 4 photos)
  const byStatus = new Map();
  // poster path -> record. The profile Media tab defaults to a VIDEOS view
  // that is a feed of inline players, not a grid: no tile anchors, no
  // permalink anywhere near the video. But each <video> carries a real
  // pbs.twimg.com poster, and that is the same image our records already
  // point at, so the poster path joins the two with no markup involved.
  // Measured on /NASA/media: 5 of 5 players resolved, all to records with a
  // playable MP4.
  const byPoster = new Map();
  // insertion-ordered list of every record we know about
  const ordered = [];
  const keys = new Set();

  // Query string and extension both vary between the DOM and the payload
  // (name=orig vs .jpg), so compare paths only.
  const posterPathOf = (url) => {
    if (!url) return null;
    try {
      return new URL(url, location.origin).pathname.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    } catch (e) {
      return null;
    }
  };

  const statusIdOf = (url) => {
    const m = /\/status\/(\d+)/.exec(url || '');
    return m ? m[1] : null;
  };
  // /user/status/<id>/photo/2 -> 2 (1-based in X's URLs)
  const mediaIndexOf = (url) => {
    const m = /\/(?:photo|video)\/(\d+)/.exec(url || '');
    return m ? parseInt(m[1], 10) : 1;
  };

  function add(record) {
    if (!record || keys.has(record.key)) return false;
    keys.add(record.key);
    ordered.push(record);
    const posterPath = posterPathOf(record.poster);
    if (posterPath && !byPoster.has(posterPath)) byPoster.set(posterPath, record);
    const id = statusIdOf(record.permalink);
    if (id) {
      record.statusId = id;
      record.mediaIndex = mediaIndexOf(record.permalink);
      if (!byStatus.has(id)) byStatus.set(id, []);
      const list = byStatus.get(id);
      list.push(record);
      list.sort((a, b) => (a.mediaIndex || 1) - (b.mediaIndex || 1));
    }
    return true;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const records = event.data && event.data[CHANNEL];
    if (!Array.isArray(records)) return;
    let added = 0;
    for (const r of records) {
      if (r && typeof r.key === 'string' && (r.poster || (r.video && r.video.src))) {
        if (add(r)) added++;
      }
    }
    if (added) global.dispatchEvent(new CustomEvent('monoclex:records', { detail: { added, total: ordered.length } }));
  });

  // page-data.js starts posting at document_start; this script loads at
  // document_idle, so the first (and most important) batch was broadcast to an
  // empty room. Ask for a replay now that the listener above exists.
  window.postMessage({ __monocleXReplay: true }, window.location.origin);

  /**
   * Fallback: recover photos from what X has already painted. Only used when
   * the network path has produced nothing — a canary for API drift, and a way
   * for the extension to stay partly useful rather than failing shut.
   */
  function harvestFromDom() {
    let added = 0;
    document.querySelectorAll('img[src*="/media/"]').forEach((img) => {
      const src = img.currentSrc || img.src || '';
      if (!/pbs\.twimg\.com/.test(src)) return;
      const anchor = img.closest('a[href*="/status/"]');
      const href = anchor ? anchor.getAttribute('href') : null;
      const base = src.split('?')[0];
      const ext = (base.match(/\.(jpg|jpeg|png|webp)$/i) || [])[1] || 'jpg';
      const rec = {
        key: base,
        type: 'photo',
        permalink: href,
        poster: `${base.replace(/\.(jpg|jpeg|png|webp)$/i, '')}?format=${ext.toLowerCase()}&name=orig`,
        thumb: `${base}?format=jpg&name=small`,
        width: null,
        height: null,
        video: null,
        durationMs: null,
        viaDomFallback: true,
      };
      if (add(rec)) added++;
    });
    return added;
  }

  /**
   * Resolve a click to a starting index in the ordered list.
   * Returns -1 when we can't place it, and the caller then leaves X alone —
   * failing silently beats hijacking a click we can't honour.
   */
  function indexForHref(href) {
    const id = statusIdOf(href);
    if (!id) return -1;
    const list = byStatus.get(id);
    if (!list || !list.length) return -1;
    const wanted = mediaIndexOf(href);
    const target = list.find((r) => (r.mediaIndex || 1) === wanted) || list[0];
    return ordered.indexOf(target);
  }

  function indexForPoster(posterUrl) {
    const record = byPoster.get(posterPathOf(posterUrl));
    return record ? ordered.indexOf(record) : -1;
  }

  /** The element whose click we should intercept, if any. */
  function tileFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      // Controls belong to X. Mute, play, the overflow menu — all of these
      // sit inside the player, and taking their clicks would break the page
      // rather than enhance it.
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') return null;
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/\/status\/\d+\/(photo|video)\/\d+/.test(href)) return { element: node, href };
        return null; // some other link — leave it alone
      }
      // Grid tiles are anchors; the Videos feed gives us a player instead.
      if (node.tagName === 'VIDEO') {
        return { element: node, poster: node.poster, video: node };
      }
      if (node.getAttribute('data-testid') === 'videoComponent') {
        const v = node.querySelector('video');
        if (v) return { element: v, poster: v.poster, video: v };
      }
    }
    return null;
  }

  function results() {
    return ordered;
  }

  function health() {
    return {
      records: ordered.length,
      photos: ordered.filter((r) => r.type === 'photo').length,
      videos: ordered.filter((r) => r.type !== 'photo').length,
      statuses: byStatus.size,
      viaDomFallback: ordered.filter((r) => r.viaDomFallback).length,
    };
  }

  global.MonocleX = { results, indexForHref, indexForPoster, tileFromEvent, harvestFromDom, health };
})(window);
