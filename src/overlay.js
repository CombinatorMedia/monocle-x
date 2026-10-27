/**
 * Builds and controls the fullscreen viewer overlay inside a Shadow DOM host
 * so none of Google's page styles leak in (and vice versa).
 */
(function (global) {
  const ICONS = {
    close: '<path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/>',
    starFilled: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    download: '<path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    filmstripToggle: '<rect x="3" y="4" width="18" height="11" rx="2" stroke="currentColor" stroke-width="2"/><rect x="3" y="18" width="4" height="3" rx="1" fill="currentColor"/><rect x="10" y="18" width="4" height="3" rx="1" fill="currentColor"/><rect x="17" y="18" width="4" height="3" rx="1" fill="currentColor"/>',
  };

  function svg(name) {
    return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">${ICONS[name]}</svg>`;
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  class MonocleXOverlay {
    constructor() {
      this.results = [];
      this.activeIndex = 0;
      this.pinned = new Set();
      this.mode = 'default'; // default | fullscreen | grid
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this._holdTimer = null;
      this._holdSpeed = 0;
      this._mounted = false;
      this._loadToken = 0;
    }

    mount() {
      if (this._mounted) return;
      this._mounted = true;

      this.host = document.createElement('div');
      this.host.id = 'monoclex-host';
      document.documentElement.appendChild(this.host);
      this.shadow = this.host.attachShadow({ mode: 'open' });

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('src/overlay.css');
      // Stylesheet loading is asynchronous even for a local extension file —
      // on the very first open() of a page session, open() calls
      // _renderFilmstrip()/_centerActiveThumb() synchronously right after
      // appending this link, before the browser has actually applied it.
      // _centerActiveThumb() reads the filmstrip's clientWidth to compute a
      // scroll position, so if that read happens pre-stylesheet (default
      // unstyled layout), it scrolls to the wrong position — the active
      // thumb ends up correctly highlighted but scrolled out of view. Once
      // the sheet finishes loading, recompute using the now-correct layout.
      // Anything that MEASURES the overlay has to wait for this, not just the
      // filmstrip centering: before it applies, .mx-root is not yet
      // position:fixed, so getBoundingClientRect on anything inside returns a
      // box thousands of pixels down the document.
      this._styleReady = new Promise((resolve) => {
        link.addEventListener('load', () => { this._centerActiveThumb(); resolve(); });
        link.addEventListener('error', resolve);
      });
      this.shadow.appendChild(link);

      this.root = el(`
        <div class="mx-root" hidden>
          <div class="mx-panel"></div>
          <div class="mx-minimap">
            <div class="mx-minimap-extent"></div>
            <div class="mx-minimap-crop"></div>
          </div>
          <div class="mx-image-frame">
            <img alt="" class="mx-photo is-active" />
            <img alt="" class="mx-photo" />
            <video class="mx-video" playsinline preload="auto"></video>
          </div>
          <div class="mx-badge">
            <span class="mx-dim"></span><span class="mx-dot">·</span><a class="mx-domain" target="_blank" rel="noopener noreferrer"></a>
          </div>
          <div class="mx-grid"></div>
          <div class="mx-shortlist-pill" title="Click to view only starred images (S)"><span class="mx-count"></span></div>
          <div class="mx-icon-cluster">
            <button class="mx-icon-btn mx-close" title="Close (Esc)">${svg('close')}</button>
            <button class="mx-icon-btn mx-filmstrip-toggle is-active" title="Toggle filmstrip / fullscreen (F)">${svg('filmstripToggle')}</button>
            <button class="mx-icon-btn mx-star" title="Shortlist (Space)">${svg('star')}</button>
            <button class="mx-icon-btn mx-grid-toggle" title="Compare mode (G)">${svg('grid')}</button>
            <button class="mx-icon-btn mx-copy" title="Copy image (C)">${svg('copy')}</button>
            <button class="mx-icon-btn mx-download" title="Download image (D)">${svg('download')}</button>
          </div>
          <div class="mx-filmstrip"></div>
          <div class="mx-zoom-pill"></div>
          <div class="mx-toast"></div>
          <div class="mx-hint"><span>Scroll to zoom</span><span class="mx-dot">·</span><span class="mx-secondary">⌘/Ctrl or Shift + Scroll to pan</span></div>
        </div>
      `);
      this.shadow.appendChild(this.root);

      this._cacheEls();
      this._bindEvents();
    }

    _cacheEls() {
      const q = (s) => this.root.querySelector(s);
      this.els = {
        imageFrame: q('.mx-image-frame'),
        // Two stacked photos so one can fade in while the other fades out.
        // A single <img> can't crossfade: swapping its src is instant, and
        // fading it means fading to empty frame and back, which is the
        // blank-between-photos problem itself.
        photos: Array.from(this.root.querySelectorAll('.mx-photo')),
        video: q('.mx-video'),
        badgeDim: q('.mx-badge .mx-dim'),
        badgeDomain: q('.mx-badge .mx-domain'),
        filmstrip: q('.mx-filmstrip'),
        starBtn: q('.mx-star'),
        gridToggleBtn: q('.mx-grid-toggle'),
        filmstripToggleBtn: q('.mx-filmstrip-toggle'),
        copyBtn: q('.mx-copy'),
        downloadBtn: q('.mx-download'),
        closeBtn: q('.mx-close'),
        shortlistPillEl: q('.mx-shortlist-pill'),
        shortlistPill: q('.mx-shortlist-pill .mx-count'),
        hint: q('.mx-hint'),
        zoomPill: q('.mx-zoom-pill'),
        toast: q('.mx-toast'),
        minimap: q('.mx-minimap'),
        minimapCrop: q('.mx-minimap-crop'),
        grid: q('.mx-grid'),
      };
    }

    _bindEvents() {
      this.els.closeBtn.addEventListener('click', () => this.close());
      this.els.starBtn.addEventListener('click', () => this.togglePin());
      this.els.filmstripToggleBtn.addEventListener('click', () => this.toggleFullscreen());
      this.els.gridToggleBtn.addEventListener('click', () => this.toggleGrid());
      this.els.copyBtn.addEventListener('click', () => this.copyCurrent());
      this.els.downloadBtn.addEventListener('click', () => this.downloadCurrent());
      this.els.shortlistPillEl.addEventListener('click', () => this.toggleShortlistView());

      this.els.imageFrame.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      this.els.imageFrame.addEventListener('mousedown', (e) => this._onPanStart(e));
      this.els.photos.forEach((p) => p.addEventListener('click', (e) => this._onImageClick(e)));

      // Click the surround to dismiss, the way a lightbox or Quick Look does.
      // Armed on mousedown and only fired if the mouseup lands on the surround
      // too, so a drag that starts on the photo and releases over the backdrop
      // (or the reverse) never closes the viewer behind your back.
      this.root.addEventListener('mousedown', (e) => {
        this._dismissArmed = e.button === 0 && this._isDismissSurface(e);
      });
      this.root.addEventListener('click', (e) => {
        const armed = this._dismissArmed;
        this._dismissArmed = false;
        if (!armed || this._imgDidDrag) return;
        if (this._isDismissSurface(e)) this.close();
      });

      this._keydownHandler = (e) => this._onKeydown(e);
      document.addEventListener('keydown', this._keydownHandler, true);
      this._keyupHandler = (e) => this._onKeyup(e);
      document.addEventListener('keyup', this._keyupHandler, true);

      // Resizing the window doesn't touch the filmstrip's contents, so
      // nothing else would re-run the centering math.
      window.addEventListener('resize', () => this._centerActiveThumb());
    }

    open(results, startIndex, originRect) {
      this.results = results;
      this.mount();
      // Class goes on BEFORE unhiding, or the chrome paints at full opacity
      // for a frame and then snaps to transparent to start the fade.
      if (originRect) this.root.classList.add('is-opening');
      this.root.hidden = false;
      this.goTo(startIndex || 0);
      this._renderFilmstrip();
      if (originRect) {
        // Backstop: is-opening holds the whole chrome at opacity 0, so if the
        // animation path ever fails to complete the viewer would be left
        // permanently invisible. Cheap insurance against a very bad failure.
        clearTimeout(this._openingFailsafe);
        this._openingFailsafe = setTimeout(() => this.root.classList.remove('is-opening'), 1500);
        this._playOpenFrom(originRect);
      }
      // Pins persist across close/reopen (see togglePin) — if you starred
      // things last time you had the viewer open, the pill should already
      // be showing that count rather than only appearing after the next
      // star/unstar action.
      this._updateShortlistPill();
    }

    close() {
      if (this.root) this.root.hidden = true;
      this._clearHold();
    }

    get current() {
      return this.results[this.activeIndex];
    }

    get visibleList() {
      return this.mode === 'shortlist' ? this.results.filter((r) => this.pinned.has(r.key)) : this.results;
    }

    // ---------- Navigation ----------

    goTo(index) {
      if (!this.results.length) return;
      this.activeIndex = ((index % this.results.length) + this.results.length) % this.results.length;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      // Clears a drag flag left over from panning the PREVIOUS image. It's
      // only ever reset inside _onPanStart, which only runs on a mousedown
      // while zoomed in — so zoom+pan on image A, then navigate to image B
      // (now at zoom 1, where a plain click never touches _onPanStart at
      // all) left the stale "true" in place, and _onImageClick swallowed
      // the very next click on B as if it were the tail end of a drag. That
      // click did reset the flag afterward, so only every OTHER image's
      // click-to-open-source-page ever worked — intermittent by design.
      this._imgDidDrag = false;
      // Stop the outgoing video before anything else: a clip left playing
      // behind the next photo keeps buffering and keeps making noise.
      this._hideVideo();
      this._applyTransform();
      this._loadCurrent();
      this._renderFilmstrip();
    }

    // Steps within whatever list is actually showing in the filmstrip right
    // now (visibleList) rather than the raw results array — otherwise arrow
    // keys in shortlist view kept walking the full linear results, ignoring
    // the filter entirely. Wraps within that subset, and if the current
    // image somehow isn't in the visible list at all (e.g. it got un-starred
    // out from under you), falls back to just starting at the first item.
    _stepIndex(direction) {
      const list = this.visibleList;
      if (!list.length) return this.activeIndex;
      const posInList = list.indexOf(this.current);
      const nextPos = ((posInList === -1 ? 0 : posInList + direction) + list.length) % list.length;
      return this.results.indexOf(list[nextPos]);
    }

    next() { this.goTo(this._stepIndex(1)); }
    prev() { this.goTo(this._stepIndex(-1)); }

    async _loadCurrent() {
      const result = this.current;
      if (!result) return;
      // Every load takes a ticket, and only the newest ticket may touch the
      // <img>. Replaces an identity check against this.current, which had a
      // hole: content.js re-scrapes on scroll and assigns a brand-new
      // results array, so this.current stops being the same OBJECT as the
      // result we started with even when it's the same image — the check
      // then failed and this returned early.
      const token = ++this._loadToken;
      this._loadStage = 0;
      this._updateBadge(result);
      this._setStarIcon(this.pinned.has(result.key));

      // Nothing to reveal: X hands over the real URL, true dimensions and the
      // permalink in the same timeline payload that drew the grid, so there is
      // no second request to wait on and no proxy to upgrade away from. That
      // whole stage of Monocle's pipeline simply doesn't exist here.
      if (result.type !== 'photo' && result.video) {
        this._showVideo(result, token);
      } else {
        this._hideVideo();
        // The poster is already decoded in the grid at thumbnail size, so the
        // small copy paints instantly while the full-resolution original
        // downloads; the stage guard keeps a late preview from beating an
        // early original to the screen.
        const full = result.poster;
        const preview = result.thumb;
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled && token === this._loadToken && preview && preview !== full) {
            this._swapImage(preview, token, null, 0);
          }
        }, 120);
        await this._swapImage(full, token, result.thumb, 1);
        settled = true;
        clearTimeout(timer);
      }

      // X only fetches the next timeline page when it thinks you're near the
      // bottom of the grid, but the viewer can outrun the rendered tiles. Ask
      // the page to load more before we hit the end of what we know.
      if (this.activeIndex >= this.results.length - 8) {
        window.dispatchEvent(new CustomEvent('monoclex:needmore'));
      }
    }

    // Video plays inline, in our own frame. X hands us progressive MP4s
    // (verified: 16/16 videos in a sample search carried mp4 variants, up to
    // 1920x1080), so a plain <video> does the job — no player library, which
    // also keeps us clear of MV3's remote-code rules. HLS is the fallback for
    // anything MP4-less; Chrome plays .m3u8 natively now (measured).
    //
    // The element must be IN the DOM before src is set. A detached <video>
    // gets deprioritised by Chrome and stalls at readyState 0 — it looks
    // exactly like a referer block, and cost an hour of misdiagnosis.
    _showVideo(result, token) {
      const v = this.els.video;
      const src = result.video.src;
      v.poster = result.thumb || result.poster || '';
      if (v.src !== src) {
        v.src = src;
        v.load();
      }
      v.muted = this._videoMuted !== false; // X autoplays muted; match that
      v.loop = result.type === 'animated_gif';
      v.classList.add('is-active');
      this.els.photos.forEach((p) => p.classList.remove('is-active'));
      const play = () => {
        if (token !== this._loadToken) return;
        v.play().catch(() => {}); // autoplay can be refused; the poster stays
      };
      if (v.readyState >= 1) play();
      else v.addEventListener('loadedmetadata', play, { once: true });
    }

    _hideVideo() {
      const v = this.els.video;
      if (!v.classList.contains('is-active') && !v.src) return;
      v.pause();
      v.classList.remove('is-active');
      // Drop the source so a paused frame can't flash behind the next photo,
      // and so we stop buffering media the viewer has moved past.
      v.removeAttribute('src');
      v.load();
    }

    _videoIsActive() {
      return this.els.video.classList.contains('is-active') && !!this.els.video.src;
    }

    _toggleVideoPlayback() {
      const v = this.els.video;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }

    // Mute state is sticky across navigation: unmute once and the rest of the
    // session plays with sound, rather than making you press M per clip.
    _toggleMute() {
      if (!this._videoIsActive()) return;
      this._videoMuted = !this.els.video.muted;
      this.els.video.muted = this._videoMuted;
      this._flash(this._videoMuted ? 'Muted' : 'Sound on');
    }

    /** Called as X loads more timeline pages while the viewer is open. */
    syncResults(results) {
      const current = this.current;
      this.results = results;
      if (current) {
        const i = results.findIndex((r) => r.key === current.key);
        if (i !== -1) this.activeIndex = i;
      }
      this._renderFilmstrip();
      this._updateShortlistPill();
    }

    // Loads the next photo into whichever of the two stacked <img>s is
    // currently hidden, and only once it has actually decoded does it
    // crossfade the two. The outgoing photo holds at full opacity the entire
    // time, so there is never a frame with nothing in the viewer.
    //
    // The old single-<img> version hid the photo (opacity 0) BEFORE awaiting
    // the reveal and only un-hid it from a successful load event. That blanked
    // the viewer for the whole reveal + download of every navigation, and three
    // paths left it blank for good: an early return (nothing un-hid it), a load
    // error (no load event fires), and re-showing an already-cached src (no
    // load event either — the case backward navigation hits most, since
    // revisited results resolve instantly from cache).
    // Two failure modes to avoid, both of which show as a flash:
    //
    // 1. Assigning src to an element that is currently PAINTING blanks it on
    //    the spot — an <img> drops its pixels the instant its src changes. The
    //    outgoing photo keeps covering the screen for the whole 180ms fade, so
    //    a navigation arriving inside that window used to pick the still-
    //    visible outgoing element as its target and blank it: measured live at
    //    a composite frame of 0.03 opacity, i.e. black. This is the flash that
    //    survived every attempt to suppress Google's panel, because it was
    //    never Google's panel. It hits hardest arrowing BACKWARD through
    //    already-visited results, where each step resolves from cache
    //    instantly and therefore lands inside the previous fade.
    // 2. Fading in an element whose image has not decoded shows a blank.
    //
    // Both are closed by decoding off-DOM first, then finishing any fade still
    // in flight before touching either element. Nothing visible is ever
    // reassigned, and nothing is faded in before it has pixels.
    _swapImage(src, token, fallbackSrc, stage = 1) {
      if (!src) return Promise.resolve(false);
      const photos = this.els.photos;
      const current = photos.find((p) => p.classList.contains('is-active')) || photos[0];
      if (current.src === src) return Promise.resolve(true); // already showing

      const start = (readySrc) => {
        if (token !== this._loadToken) return; // a newer load owns the frame now
        // Stages run one way only: a preview that decodes late must never
        // replace the full-resolution photo that beat it to the screen.
        if (stage < this._loadStage) return;
        this._loadStage = stage;
        const showing = photos.find((p) => p.classList.contains('is-active')) || photos[0];
        if (showing.src === readySrc) return;
        const next = photos.find((p) => p !== showing);

        // Land the previous crossfade instantly: the incoming photo of that
        // fade jumps to fully opaque, the outgoing to fully transparent. Only
        // then is `next` guaranteed invisible and safe to reassign. Snapping
        // BOTH matters — snapping only the one being reused would leave a
        // half-faded photo alone on screen, which is the same dim frame in a
        // different costume.
        showing.style.transition = 'none';
        next.style.transition = 'none';
        showing.classList.add('is-active');
        next.classList.remove('is-active');
        void next.offsetWidth; // flush the snap before re-enabling transitions
        showing.style.transition = '';
        next.style.transition = '';

        next.src = readySrc;
        next.classList.add('is-active');
        showing.classList.remove('is-active');
      };

      // decode() resolves only once the pixels are ready to paint, so the
      // element we hand this src to renders on its very first frame.
      const pre = new Image();
      pre.src = src;
      const onFail = () => {
        // A hotlink-blocked or dead origin URL — roughly 1 in 10 records point
        // at http:// and Chrome's automatic HTTPS upgrade can fail outright.
        // Falling back keeps a picture on screen instead of a broken-image
        // glyph. Reuses this stage so the fallback can still take the screen.
        if (fallbackSrc && fallbackSrc !== src) return this._swapImage(fallbackSrc, token, null, stage);
        return false;
      };
      if (pre.decode) {
        return pre.decode().then(() => { start(src); return true; }, onFail);
      }
      return new Promise((resolve) => {
        pre.onload = () => { start(src); resolve(true); };
        pre.onerror = () => resolve(onFail());
      });
    }

    // Thousands separators, so grid-compare badges read the same as the main
    // one ("1,600 × 1,600", not "1600 × 1600").
    _formatDims(result) {
      if (!result || !result.width || !result.height) return '';
      return `${result.width.toLocaleString()} × ${result.height.toLocaleString()}`;
    }

    // Grows the photo out of the thumbnail that was clicked (a FLIP: measure
    // where it should end up, invert to where it came from, then play to
    // identity). A real Dock genie is a non-affine warp — the shape curves as
    // it travels — which CSS transforms can't express, and the per-pixel
    // routes to it are closed here: canvas and WebGL both need CORS-clean
    // pixels, and these images are cross-origin without CORS headers.
    //
    // Opens on the grid thumbnail, which is already decoded and on screen, so
    // there is something to animate on the very first frame instead of
    // waiting on the reveal. The full-resolution file crossfades in when it
    // arrives, through the same _swapImage path as any other navigation.
    async _playOpenFrom(rect) {
      const photo = this.els.photos.find((p) => p.classList.contains('is-active')) || this.els.photos[0];
      const result = this.current;
      const finish = () => this.root.classList.remove('is-opening');

      if (result && result.thumb) photo.src = result.thumb;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }

      // On the very first open the stylesheet may not have applied yet, and
      // measuring the photo before it does yields a box far down the document
      // instead of the fixed-position frame — which threw the animation's
      // start point thousands of pixels off.
      if (this._styleReady) await this._styleReady;

      const from = rect;
      const box = photo.getBoundingClientRect();
      if (!box.width || !from.width || !from.height) { finish(); return; }

      // object-fit: contain means the painted picture is inset within the
      // element, so the element's own box is the wrong thing to match against
      // the thumbnail — measure the painted area instead.
      //
      // The ratio comes from the clicked tile rather than the image's own
      // naturalWidth, which would mean awaiting decode() and losing the first
      // ~200ms of the animation to it. Google's grid preserves each image's
      // aspect ratio (verified: a 235x453 tile for a 638x1200 source), so the
      // tile's shape is the picture's shape.
      const natAR = from.width / from.height;
      const boxAR = box.width / box.height;
      const paintedW = natAR > boxAR ? box.width : box.height * natAR;
      const paintedH = natAR > boxAR ? box.width / natAR : box.height;

      const scale = Math.max(from.width / paintedW, from.height / paintedH);
      const tx = from.left + from.width / 2 - (box.left + box.width / 2);
      const ty = from.top + from.height / 2 - (box.top + box.height / 2);

      photo.style.transition = 'none';
      photo.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      void photo.offsetWidth; // flush the inverted state before playing
      photo.style.transition = 'transform 340ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      photo.style.transform = 'translate(0px, 0px) scale(1)';

      const done = () => {
        clearTimeout(timer);
        photo.removeEventListener('transitionend', done);
        photo.style.transition = '';
        finish();
      };
      // transitionend can be missed if the tab is backgrounded mid-animation,
      // which would strand the chrome at opacity 0.
      const timer = setTimeout(done, 700);
      photo.addEventListener('transitionend', done);
    }

    // On X the useful second field is who posted it, not a hostname — every
    // result is on the same host. The handle is read from the permalink
    // (/<handle>/status/<id>/photo/<n>) rather than from any payload field, so
    // it survives X renaming things in its JSON.
    _authorOf(result) {
      const m = /^\/?([^/]+)\/status\/\d+/.exec(result && result.permalink ? result.permalink.replace(/^https?:\/\/[^/]+/, '') : '');
      return m ? `@${m[1]}` : '';
    }

    _updateBadge(result) {
      const dims = this._formatDims(result);
      const duration = result.durationMs ? this._formatDuration(result.durationMs) : '';
      this.els.badgeDim.textContent = duration ? `${dims}${dims ? ' · ' : ''}${duration}` : dims;
      this.els.badgeDomain.textContent = this._authorOf(result);
      if (result.permalink) {
        this.els.badgeDomain.href = new URL(result.permalink, location.origin).href;
      } else {
        this.els.badgeDomain.removeAttribute('href');
      }
    }

    _formatDuration(ms) {
      const total = Math.round(ms / 1000);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    // Starred state is shown by swapping to a solid-filled star (not an
    // outline ring around the button, like the other active icons) — so the
    // icon itself has to change, not just get a color/outline toggled.
    _setStarIcon(isStarred) {
      this.els.starBtn.classList.toggle('is-starred', isStarred);
      this.els.starBtn.innerHTML = svg(isStarred ? 'starFilled' : 'star');
    }

    // ---------- Filmstrip ----------

    _renderFilmstrip() {
      const list = this.visibleList;
      this.els.filmstrip.innerHTML = '';
      list.forEach((result) => {
        const realIndex = this.results.indexOf(result);
        const thumb = el(`<div class="mx-thumb" style="background-image:url('${result.thumb}')"></div>`);
        if (realIndex === this.activeIndex) thumb.classList.add('is-active');
        // Mark video entries so the strip tells you what's coming: a play
        // glyph, plus the running time when X gave us one.
        if (result.type !== 'photo') {
          thumb.classList.add('is-video');
          if (result.durationMs) {
            thumb.appendChild(el(`<div class="mx-duration">${this._formatDuration(result.durationMs)}</div>`));
          }
        }
        if (this.pinned.has(result.key)) {
          thumb.classList.add('is-pinned');
          thumb.appendChild(el(`<div class="mx-pin">${svg('starFilled')}</div>`));
          thumb.querySelector('.mx-pin svg').style.color = '#ffb454';
        }
        thumb.addEventListener('click', () => this.goTo(realIndex));
        this.els.filmstrip.appendChild(thumb);
      });
      this._centerActiveThumb();
    }

    // The filmstrip spans edge-to-edge (left:0; right:0), so centering the
    // active thumb within the filmstrip's own scroll viewport IS centering
    // it in the window. Computed explicitly (rather than scrollIntoView,
    // which centers relative to whatever the browser decides is the nearest
    // scrollable ancestor) so it stays exact — including after a window
    // resize, when nothing else about the filmstrip changes to trigger it.
    // A thumb near the very start or end of the list has too few neighbors
    // on one side to ever be scrolled to center — there's simply no track
    // left to scroll into (scrollLeft clamps at 0/max, which is why the
    // first several thumbs always looked stuck at the left edge). The fix
    // used by every center-anchored carousel: pad both ends of the scrolling
    // track with "runway" equal to half the viewport (minus half a thumb),
    // so even the very first or last thumb has room to reach center.
    _updateFilmstripRunway() {
      const runway = Math.max(16, this.els.filmstrip.clientWidth / 2 - 40);
      this.els.filmstrip.style.paddingLeft = `${runway}px`;
      this.els.filmstrip.style.paddingRight = `${runway}px`;
    }

    _centerActiveThumb() {
      this._updateFilmstripRunway();
      const activeEl = this.els.filmstrip.querySelector('.is-active');
      if (!activeEl) return;
      const target = activeEl.offsetLeft + activeEl.offsetWidth / 2 - this.els.filmstrip.clientWidth / 2;
      this.els.filmstrip.scrollLeft = Math.max(0, target);
    }

    // ---------- Shortlist ----------

    togglePin() {
      const result = this.current;
      if (!result) return;
      // Tracked by the image's own stable id, not its array index — indices
      // shift every time the page is re-scraped (which happens on every
      // open, and again on scroll), so an index-based pin would silently
      // point at a different image next time. Also intentionally never
      // cleared on close(): starring should survive closing and reopening
      // the viewer on this same results page (a real page reload/new search
      // naturally resets it anyway, since the whole script reinitializes).
      if (this.pinned.has(result.key)) this.pinned.delete(result.key);
      else this.pinned.add(result.key);
      this._setStarIcon(this.pinned.has(result.key));
      this._updateShortlistPill();
      // Un-starring the last item while already filtered to shortlist-only
      // would otherwise leave the view showing nothing with no way back.
      if (this.mode === 'shortlist' && this.pinned.size === 0) this.toggleShortlistView();
      this._renderFilmstrip();
    }

    _updateShortlistPill() {
      this.els.shortlistPill.textContent = `Shortlist · ${this.pinned.size}`;
      this.els.shortlistPillEl.classList.toggle('is-visible', this.pinned.size > 0);
    }

    toggleShortlistView() {
      this.mode = this.mode === 'shortlist' ? 'default' : 'shortlist';
      this.root.classList.toggle('is-shortlist', this.mode === 'shortlist');
      // Switching into shortlist view while looking at a non-starred image
      // would otherwise leave the main image showing something that isn't
      // even in the filtered filmstrip, with no thumbnail marked active.
      const current = this.current;
      if (this.mode === 'shortlist' && (!current || !this.pinned.has(current.key))) {
        const list = this.visibleList;
        if (list.length) {
          this.goTo(this.results.indexOf(list[0]));
          return; // goTo() already re-renders the filmstrip
        }
      }
      this._renderFilmstrip();
    }

    // ---------- Fullscreen (filmstrip hidden) ----------

    toggleFullscreen() {
      const isFull = this.root.classList.toggle('is-fullscreen');
      this.els.filmstripToggleBtn.classList.toggle('is-active', !isFull);
    }

    // ---------- Grid compare ----------

    toggleGrid() {
      const isGrid = this.root.classList.toggle('is-grid');
      this.els.gridToggleBtn.classList.toggle('is-active', isGrid);
      if (isGrid) this._renderGrid();
    }

    async _renderGrid() {
      let source;
      if (this.pinned.size >= 2) {
        // The shortlist itself is uncapped (star as many as you want — they
        // all show in the filtered filmstrip), but Grid Compare's layout is
        // a fixed 2x2, so it shows your 4 MOST RECENTLY starred rather than
        // capping/evicting the shortlist itself. Set iteration order is
        // insertion order, so the last 4 ids are the most recent stars.
        // Resolved by id against the current results (not stored indices),
        // and silently dropped if an id no longer appears in this scrape.
        source = [...this.pinned]
          .slice(-4)
          .map((id) => this.results.find((r) => r.id === id))
          .filter(Boolean);
      } else {
        source = this.results.slice(this.activeIndex, this.activeIndex + 4);
      }
      this.els.grid.innerHTML = '';
      const cells = source.slice(0, 4).map((result) => {
        const cell = el(`<div class="mx-grid-cell">
          <img alt="" src="${result.thumb}" />
          <div class="mx-badge"><span class="mx-dim">${result.width ? this._formatDims(result) : ''}</span><span class="mx-dot">·</span><span class="mx-domain">${this._authorOf(result)}</span></div>
        </div>`);
        this.els.grid.appendChild(cell);
        return { cell, result };
      });
      // No reveal step on X: the full-resolution URL arrived with the
      // timeline payload, so each cell goes straight to its original. Videos
      // show their poster here — compare mode is for looking, not playback.
      // Compare-mode badges are display-only (no link); the permalink stays
      // on the main and shortlist views only.
      for (const { cell, result } of cells) {
        cell.querySelector('img').src = result.poster || result.thumb;
      }
    }

    // ---------- Zoom + pan ----------

    _applyTransform() {
      // Both photos, so zoom/pan carries across a crossfade instead of the
      // incoming one snapping back to 1x mid-fade.
      const t = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      this.els.photos.forEach((p) => { p.style.transform = t; });
      const zoomed = this.zoom > 1.01;
      this.els.zoomPill.textContent = `${Math.round(this.zoom * 100)}%`;
      this.els.zoomPill.style.opacity = zoomed ? '1' : '0';
      this.els.minimap.classList.toggle('is-visible', zoomed);
      // This was never actually wired up before — the hint pill's CSS only
      // shows it via an .is-visible class that nothing ever toggled, so it
      // was permanently invisible regardless of zoom state.
      this.els.hint.classList.toggle('is-visible', zoomed);
      if (zoomed) this._updateMinimap();
    }

    _updateMinimap() {
      const w = 94 / this.zoom;
      const h = 54 / this.zoom;
      const cx = 8 + 47 - w / 2 - (this.pan.x / 300) * 47;
      const cy = 8 + 27 - h / 2 - (this.pan.y / 300) * 27;
      Object.assign(this.els.minimapCrop.style, {
        left: `${Math.max(8, Math.min(94, cx))}px`,
        top: `${Math.max(8, Math.min(54, cy))}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    }

    _onWheel(e) {
      e.preventDefault();
      const isPanModifier = e.metaKey || e.ctrlKey;
      const isShiftPan = e.shiftKey && !isPanModifier;
      if (isPanModifier) {
        this.pan.x -= e.deltaX;
        this.pan.y -= e.deltaY;
      } else if (isShiftPan) {
        // Horizontal-only pan. Some trackpads/browsers already convert a
        // shift+vertical scroll into deltaX before this handler sees it;
        // fall back to deltaY so it works the same either way.
        this.pan.x -= (e.deltaX !== 0 ? e.deltaX : e.deltaY);
      } else {
        const delta = -e.deltaY * 0.0015;
        this.zoom = Math.min(4, Math.max(1, this.zoom + delta));
        if (this.zoom === 1) this.pan = { x: 0, y: 0 };
      }
      this._applyTransform();
    }

    _onPanStart(e) {
      if (this.zoom <= 1) return;
      const start = { x: e.clientX, y: e.clientY };
      const startPan = { ...this.pan };
      // Tracks whether this gesture actually moved (vs. a plain click) so
      // the click handler below can tell a pan-drag apart from a click
      // intended to open the source page — the native "click" event still
      // fires on mouseup regardless of how far the pointer traveled.
      this._imgDidDrag = false;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - start.x) > 3 || Math.abs(ev.clientY - start.y) > 3) {
          this._imgDidDrag = true;
        }
        this.pan.x = startPan.x + (ev.clientX - start.x);
        this.pan.y = startPan.y + (ev.clientY - start.y);
        this._applyTransform();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    // Everything that is NOT the photo itself or a piece of chrome counts as
    // the surround, and clicking it dismisses.
    //
    // The subtlety is the photo element: it is absolutely positioned across
    // the whole frame with object-fit:contain, so for any image whose shape
    // differs from the frame's, a large part of that element is empty
    // letterbox. Treating the element as "the photo" would make those empty
    // bands — visually indistinguishable from the surround — do nothing,
    // which is exactly where people aim. So the test is against the PAINTED
    // picture, not the element box.
    _isDismissSurface(e) {
      const path = e.composedPath();
      const chrome = [
        this.els.filmstrip,
        this.els.badge || this.root.querySelector('.mx-badge'),
        this.root.querySelector('.mx-icon-cluster'),
        this.els.shortlistPillEl,
        this.els.hint,
        this.els.zoomPill,
        this.els.toast,
        this.els.minimap,
      ].filter(Boolean);
      for (const node of path) {
        if (node === this.root) break; // reached the top without hitting chrome
        if (!(node instanceof Element)) continue;
        if (chrome.includes(node)) return false;
        if (node.classList && node.classList.contains('mx-grid-cell')) return false;
        if (node.tagName === 'BUTTON' || node.tagName === 'A') return false;
        if (node.classList && node.classList.contains('mx-photo')) {
          return !this._pointOverPicture(e, node);
        }
      }
      return true;
    }

    // Where the picture actually paints inside a contain-fitted <img>. The
    // element's own rect already carries the zoom/pan transform (a uniform
    // scale plus a translate, never a rotation), so the painted box is simply
    // that rect's largest centered sub-rect with the image's aspect ratio.
    _pointOverPicture(e, img) {
      if (!img.naturalWidth || !img.naturalHeight) return false;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const ratio = img.naturalWidth / img.naturalHeight;
      let w = rect.width;
      let h = w / ratio;
      if (h > rect.height) {
        h = rect.height;
        w = h * ratio;
      }
      const left = rect.left + (rect.width - w) / 2;
      const top = rect.top + (rect.height - h) / 2;
      return e.clientX >= left && e.clientX <= left + w && e.clientY >= top && e.clientY <= top + h;
    }

    // Clicking the main image opens its source page — the same destination
    // as the badge's domain link — but only for a genuine click, not the
    // mouseup at the end of a pan-drag.
    _onImageClick(e) {
      if (this._imgDidDrag) {
        this._imgDidDrag = false;
        return;
      }
      // Only the picture opens the source. The letterbox bands of this same
      // element read as background to the eye, and now behave that way too:
      // they fall through to the dismiss handler instead of launching a tab.
      if (!this._pointOverPicture(e, e.currentTarget)) return;
      const sourcePage = this.current && this.current.permalink;
      if (sourcePage) window.open(new URL(sourcePage, location.origin).href, '_blank', 'noopener,noreferrer');
    }

    // ---------- Copy / download ----------

    // The bytes are fetched in the background service worker, which holds
    // host_permissions for both media hosts and so is bound by neither the
    // page's CSP nor CORS. It hands them back as a data URL. (Monocle needed
    // this because Google Images points at arbitrary hosts; here it is simply
    // the path that can't be broken by a CSP change on X's side.)
    _fetchViaBackground(src) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'mx-fetch-image', url: src }, async (response) => {
          if (!response || !response.ok) { resolve(null); return; }
          try {
            const res = await fetch(response.dataUrl); // data: URL, not a network request
            resolve({ blob: await res.blob() });
          } catch (e) {
            resolve(null);
          }
        });
      });
    }

    // navigator.clipboard.write pastes most reliably as image/png across
    // other apps, regardless of the source format (jpeg/webp/etc).
    // Converting via a data:-sourced canvas avoids any cross-origin taint.
    async _toPngBlob(blob) {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    // Copy takes the picture, download takes the file. On a video that means
    // the poster frame, never the MP4: asking for the video here used to pull
    // the whole file through the service worker, fail createImageBitmap on it,
    // and fall back to putting a bare video.twimg.com URL on the clipboard
    // under the toast "Image copied". Measured: 827ms wasted on a 58-second
    // clip for a result nobody wanted.
    async copyCurrent() {
      const src = this.current && (this.current.poster || this.current.thumb);
      if (!src) return;
      try {
        const result = await this._fetchViaBackground(src);
        if (!result || !result.blob) throw new Error('background fetch failed');
        const pngBlob = await this._toPngBlob(result.blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        this._flash('Image copied');
      } catch (e) {
        try {
          await navigator.clipboard.writeText(src);
          this._flash('Image URL copied');
        } catch (_) {
          this._flash("Couldn't copy this image");
        }
      }
    }

    _flash(message) {
      const el = this.els.toast;
      el.textContent = message;
      el.classList.add('is-visible');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
    }

    downloadCurrent() {
      const src = this.current && ((this.current.video && this.current.video.src) || this.current.poster || this.current.thumb);
      if (!src) return;
      chrome.runtime.sendMessage({ type: 'mx-download', url: src });
    }

    // ---------- Keyboard ----------

    _onKeydown(e) {
      if (!this.root || this.root.hidden) return;
      // Case-fold the letter keys and read Shift from the modifier rather than
      // from the character. Distinguishing s from S by character inverts the
      // whole pair under Caps Lock — S would open the shortlist and Shift+S
      // would star — and silently kills every other letter shortcut on
      // layouts that report an uppercase character. Measured: with Caps Lock
      // on, e.key for the S key is 'S'.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      switch (key) {
        // Escape steps back out one layer at a time rather than closing
        // outright, so the shortlist always has a way back to the single
        // image view even if the pill is missed or mis-clicked.
        case 'Escape':
          if (this.mode === 'shortlist') this.toggleShortlistView();
          else this.close();
          break;
        case 'ArrowRight': this._startHold(1); break;
        case 'ArrowLeft': this._startHold(-1); break;
        // Space plays/pauses when a video is up — the binding everyone
        // already expects from every other player. Starring moves to S,
        // which is where the shortlist VIEW used to live; that moves to
        // Shift+S. On a photo, Space still stars, so the muscle memory
        // carried over from Monocle keeps working where it can.
        case ' ':
          e.preventDefault();
          if (this._videoIsActive()) this._toggleVideoPlayback();
          else this.togglePin();
          break;
        case 'm': this._toggleMute(); break;
        case 'f': this.toggleFullscreen(); break;
        case 'g': this.toggleGrid(); break;
        case 'c': this.copyCurrent(); break;
        case 'd': this.downloadCurrent(); break;
        case 's':
          if (e.shiftKey) this.toggleShortlistView();
          else this.togglePin();
          break;
        default: return;
      }
      e.preventDefault();
    }

    _onKeyup(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') this._clearHold();
    }

    _startHold(dir) {
      if (this._holdTimer) return;
      this.goTo(this._stepIndex(dir));
      let interval = 260;
      const step = () => {
        this.goTo(this._stepIndex(dir));
        interval = Math.max(60, interval * 0.8);
        this._holdTimer = setTimeout(step, interval);
      };
      this._holdTimer = setTimeout(step, interval);
    }

    _clearHold() {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
  }

  global.MonocleXOverlay = new MonocleXOverlay();
})(window);
