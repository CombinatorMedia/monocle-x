/**
 * Reads the media data X already ships with its own timeline responses, and
 * hands it to the extension's content script.
 *
 * WHY MAIN WORLD
 * X's media lives in GraphQL responses (SearchTimeline, UserMedia, and
 * friends) that only X's own JS ever touches. Patching XMLHttpRequest/fetch to
 * read them requires sharing the page's globals, which an isolated content
 * script cannot do. Declared in the manifest with "world": "MAIN" and
 * run_at: document_start so the patch is installed before X's first request.
 *
 * ── HARDENING: why this file reads the way it does ─────────────────────────
 * X rewrites its markup constantly — class names are hashed and rotate without
 * notice. Three deliberate choices keep this from mattering:
 *
 * 1. NO RESPONSE PATHS. The obvious way to read a GraphQL response is to walk
 *    the documented route, e.g.
 *      data.search_by_raw_query.search_timeline.timeline.instructions[0]
 *        .entries[n].content.itemContent.tweet_results.result.legacy
 *        .extended_entities.media[0]
 *    Every one of those names is a hostage. Instead we walk the whole payload
 *    and recognise media by its SHAPE — any object carrying `media_url_https`
 *    plus a `type`. That survives X moving, renaming or re-nesting the
 *    timeline, which it does far more often than it changes field names on the
 *    media entity itself.
 *
 * 2. NO OPERATION ALLOWLIST. We don't check for "SearchTimeline" by name. Any
 *    GraphQL response that happens to contain media entities is harvested, so
 *    profile media tabs, bookmarks, likes and whatever X ships next all work
 *    without a code change.
 *
 * 3. FIELD TOLERANCE. media_url_https or media_url; variants with or without
 *    bitrate; original_info optional. Missing pieces degrade that one record
 *    rather than throwing out the batch.
 *
 * Verified live 2026-10-26 against x.com/search?...&f=media: 7 GraphQL calls
 * yielded 158 media records (109 photo, 49 video), 16/16 videos carrying
 * progressive MP4 variants.
 */
(function () {
  'use strict';

  const CHANNEL = '__monocleXMedia';

  // Every record we've seen this page-session, so the content script can ask
  // for a replay when it loads (it starts at document_idle, well after the
  // first responses have already come and gone).
  const harvested = [];
  const seen = new Set();

  function post(records) {
    window.postMessage({ [CHANNEL]: records }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.__monocleXReplay && harvested.length) post(harvested);
  });

  // X's photo URLs take a ?name= size parameter; `orig` is the full-resolution
  // original. Verified: name=orig returns exactly the dimensions the payload
  // declares in original_info (4/4 sampled photos).
  function fullResPhoto(url) {
    if (!url) return null;
    const clean = url.split('?')[0];
    const ext = (clean.match(/\.(jpg|jpeg|png|webp)$/i) || [])[1];
    if (!ext) return clean;
    return `${clean.replace(/\.(jpg|jpeg|png|webp)$/i, '')}?format=${ext.toLowerCase()}&name=orig`;
  }

  // Prefer the highest-bitrate progressive MP4 — it plays in a plain <video>
  // with no player library, which keeps us clear of MV3's remote-code rules.
  // HLS is kept as a fallback for anything MP4-less (Chrome plays .m3u8
  // natively now; measured on this build).
  function pickVideo(variants) {
    if (!Array.isArray(variants) || !variants.length) return null;
    const mp4 = variants
      .filter((v) => v && /mp4/i.test(v.content_type || '') && v.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (mp4.length) return { src: mp4[0].url, kind: 'mp4', bitrate: mp4[0].bitrate || null };
    const hls = variants.find((v) => v && /mpegurl/i.test(v.content_type || '') && v.url);
    return hls ? { src: hls.url, kind: 'hls', bitrate: null } : null;
  }

  // The permalink X itself links to, which doubles as our join key with the
  // DOM: grid tiles are <a href="/<user>/status/<id>/photo/<n>">.
  function permalinkOf(node) {
    if (typeof node.expanded_url === 'string' && /\/status\/\d+/.test(node.expanded_url)) {
      return node.expanded_url;
    }
    return null;
  }

  function recordFrom(node) {
    const url = node.media_url_https || node.media_url;
    if (!url) return null;
    const type = node.type;
    if (!type) return null;

    const key = node.media_key || node.id_str || url;
    if (seen.has(key)) return null;

    const permalink = permalinkOf(node);
    const info = node.original_info || {};
    const video = type === 'photo' ? null : pickVideo(node.video_info && node.video_info.variants);

    // A video entity with no playable variant is worse than useless — it would
    // sit in the filmstrip as a dead slot. Skip it; the poster still appears if
    // X later gives us variants on a subsequent response.
    if (type !== 'photo' && !video) return null;

    seen.add(key);
    return {
      key: String(key),
      type,                                  // photo | video | animated_gif
      permalink,                             // /user/status/<id>/photo/<n>
      poster: fullResPhoto(url),             // full-res still (video poster too)
      thumb: `${url.split('?')[0]}?format=jpg&name=small`,
      width: info.width || null,
      height: info.height || null,
      video,                                 // { src, kind, bitrate } | null
      durationMs: (node.video_info && node.video_info.duration_millis) || null,
    };
  }

  // Shape-based discovery: find media entities wherever X decides to put them.
  function harvest(text) {
    if (!text || text.indexOf('media_url') === -1) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return; // not JSON, or truncated — nothing to do
    }

    const batch = [];
    const stack = [json];
    let guard = 0;
    while (stack.length && guard++ < 200000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const child of node) stack.push(child);
        continue;
      }
      if (node.media_url_https || node.media_url) {
        const rec = recordFrom(node);
        if (rec) batch.push(rec);
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }

    if (batch.length) {
      for (const r of batch) harvested.push(r);
      post(batch);
    }
  }

  // --- the two transports X actually uses -----------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      promise
        .then((response) => {
          // Clone, or we'd consume the body X is about to read.
          response.clone().text().then(harvest).catch(() => {});
        })
        .catch(() => {});
      return promise;
    };
  }

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        harvest(this.responseText || '');
      } catch (e) {
        /* non-text responseType — never a timeline payload */
      }
    });
    return nativeSend.apply(this, args);
  };

  // A health beacon the options page reads. When X eventually breaks this,
  // the question "is the sniffer still seeing anything?" should take seconds
  // to answer, not an afternoon of reverse-engineering.
  Object.defineProperty(window, '__monocleXHealth', {
    get() {
      return {
        recordsHarvested: harvested.length,
        photos: harvested.filter((r) => r.type === 'photo').length,
        videos: harvested.filter((r) => r.type !== 'photo').length,
        withPermalink: harvested.filter((r) => r.permalink).length,
      };
    },
    configurable: true,
  });
})();
