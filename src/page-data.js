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
 * THREE TRANSPORTS, NOT TWO
 * Measured on x.com 2026-10-27: X delivers the FIRST page of a media timeline
 * inside the HTML document, not over fetch. The search document carries a
 * ~228KB inline <script> holding a streamed Relay payload
 * (`GraphQLRequestStream.Completed`) with the response JSON escaped one level
 * into a JS string literal — 96 media entities, permalinks and video variants
 * all present. Only pagination (scroll) and in-app navigation go through
 * fetch. So patching fetch alone catches everything EXCEPT the images actually
 * on screen when the page opens: a cold load of /search?...&f=media rendered
 * 48 tiles and harvested 0 records, and the first click fell through to X's
 * own lightbox.
 *
 * That script ends with `document.currentScript.remove()`, so it is gone from
 * the DOM before anything that waits for DOMContentLoaded can read it. It has
 * to be caught as it is parsed — hence the MutationObserver below, which holds
 * a reference to the detached node and reads its text after the fact.
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

  // Counters behind __monocleXHealth. When X changes something, the first
  // question is always "did we even see the response?" — these answer it
  // without a debugger.
  const stats = { installedAt: Math.round(performance.now()), fetchSeen: 0, xhrSeen: 0, bodiesScanned: 0, noMediaField: 0, parseFailed: 0, batches: 0, fromDocument: 0 };
  const log = [];
  const note = (where, url, len, outcome) => {
    if (log.length < 60) log.push({ where, url: String(url || '').split('?')[0].slice(-48), len, outcome });
  };

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
  function harvest(text, where, url) {
    stats.bodiesScanned++;
    if (!text || text.indexOf('media_url') === -1) {
      stats.noMediaField++;
      note(where, url, text ? text.length : 0, 'no media_url');
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      stats.parseFailed++;
      note(where, url, text.length, 'parse failed');
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

    note(where, url, text.length, `${batch.length} records`);
    if (batch.length) {
      stats.batches++;
      for (const r of batch) harvested.push(r);
      post(batch);
    }
  }

  // --- transport 3: the payload streamed inside the HTML document -----------

  // The embedded JSON is escaped exactly one level (`\"` for a quote) because
  // it lives inside a JS string literal. One left-to-right pass collapses that
  // level correctly for every case that matters here: `\"` -> `"` restores the
  // structure, `\\` -> `\` turns a doubly-escaped `\\n` back into the `\n` that
  // JSON.parse itself understands, and `\\\"` -> `\"` keeps a literal quote
  // inside a string literal escaped.
  const unescapeOnce = (text) => text.replace(/\\(["\\\/])/g, '$1');

  /**
   * Extract the single JSON object enclosing `idx` from `text`.
   *
   * Deliberately NOT a parse of the surrounding script: that script is
   * JavaScript, not JSON, and its exact shape (`($R=>$R[28].next(...))`) is
   * the most churn-prone thing in this file. Instead we ignore the wrapper
   * entirely and lift out just the media entity, which is the same object the
   * fetch path already hands to recordFrom(). Walking back to the enclosing
   * brace does not track string boundaries — a `{` inside tweet text could
   * mislead it — so a bad guess simply fails JSON.parse and costs that one
   * record. Measured on a live search document: 96 of 96 entities recovered.
   */
  function objectAt(text, idx) {
    // A media entity is a couple of kilobytes at most, and this runs inside a
    // MutationObserver callback during page load, so both scans are bounded
    // rather than allowed to sweep a 228KB blob 96 times over.
    const WINDOW = 8000;
    const floor = Math.max(0, idx - WINDOW);
    const ceiling = Math.min(text.length, idx + WINDOW);
    let depth = 0;
    let start = -1;
    for (let i = idx; i >= floor; i--) {
      const c = text[i];
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start === -1) return null;

    let inString = false;
    let escaped = false;
    let depthFwd = 0;
    for (let i = start; i < ceiling; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depthFwd++;
      else if (c === '}') {
        depthFwd--;
        if (depthFwd === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function harvestScript(raw, where) {
    if (!raw || raw.indexOf('media_url') === -1) return;
    stats.bodiesScanned++;
    const text = unescapeOnce(raw);
    const batch = [];
    let at = -1;
    let misses = 0;
    while ((at = text.indexOf('media_url', at + 1)) !== -1) {
      const object = objectAt(text, at);
      if (!object) { misses++; continue; }
      try {
        const rec = recordFrom(JSON.parse(object));
        if (rec) batch.push(rec);
      } catch (e) {
        misses++;
      }
    }
    note(where, location.pathname, raw.length, `${batch.length} records, ${misses} missed`);
    if (batch.length) {
      stats.batches++;
      stats.fromDocument += batch.length;
      for (const r of batch) harvested.push(r);
      post(batch);
    }
  }

  // Catch the inline payload around its own removal.
  //
  // Reading the node when the parser INSERTS it is too early: X streams the
  // document, so the script element appears with only the first chunk of its
  // text. Measured on a live search: the block is 209,317 characters holding
  // 54 media entities, and an insertion-time read saw 65,000 of them and
  // recovered 15 — the parser's first flush, nothing more.
  //
  // The reliable moment is removal. The script's last statement is
  // `document.currentScript.remove()`, which can only run once the whole tag
  // has been parsed and executed, so a removal record means the text is
  // complete — and the record keeps the detached node alive for us to read.
  // Scans are idempotent (recordFrom dedupes on media_key), so the
  // insertion-time pass is kept as a cheap net for any small inline block
  // that arrives whole, and DOMContentLoaded sweeps up anything that is
  // never removed. Three chances, no shared point of failure.
  function watchDocumentScripts() {
    const scanned = new WeakMap();
    const scan = (node) => {
      if (!node || node.tagName !== 'SCRIPT' || node.src) return;
      const text = node.textContent;
      if (!text || scanned.get(node) === text.length) return;
      scanned.set(node, text.length);
      harvestScript(text, 'inline');
    };
    document.querySelectorAll('script:not([src])').forEach(scan);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) scan(node);
        for (const node of record.removedNodes) scan(node);
      }
    });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    // X ships the timeline in the first document and never re-streams one, so
    // once the page is parsed there is nothing left for this to catch.
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('script:not([src])').forEach(scan);
      setTimeout(() => observer.disconnect(), 2000);
    });
  }

  if (document.documentElement) watchDocumentScripts();
  else document.addEventListener('readystatechange', watchDocumentScripts, { once: true });

  // --- the two network transports -------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
      stats.fetchSeen++;
      promise
        .then((response) => {
          // Clone, or we'd consume the body X is about to read.
          response.clone().text().then((t) => harvest(t, 'fetch', url)).catch(() => {});
        })
        .catch(() => {});
      return promise;
    };
  }

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    stats.xhrSeen++;
    this.addEventListener('load', () => {
      try {
        harvest(this.responseText || '', 'xhr', this.responseURL);
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
        stats,
        log,
      };
    },
    configurable: true,
  });
})();
