# Chrome Web Store listing — Monocle for X

## Name
Monocle for X | Full Screen Media Viewer

## Short description (132 char max)
Open a photo on X and there is no next. Monocle gives the arrow keys back — every result fullscreen, video playing inline.

## Category
Productivity

## Language
English (United States)

---

## Detailed description

Open a photo on X and you've hit a dead end. There is no next. To see the
following image you close it, hunt for the next tile, open that one — and
again, and again. A hundred photos is a hundred round trips.

Monocle gives the arrow keys back.

Click any media tile and it opens fullscreen, and ← → walk the entire set.
Hold an arrow and it accelerates. You never close the viewer until you're
done looking.

IT SHOWS YOU MORE THAN THE PAGE DOES

• The original file, not the copy. X serves the grid a downscaled image.
  Monocle requests the original the post was uploaded with, so you're looking
  at full resolution — often several times the pixels the page would hand you.

• Photos and videos together. X makes you pick one or the other from the Media
  dropdown. Monocle's filmstrip carries both at once, because it reads what
  the timeline actually returned rather than what the tab is filtered to.

• Past the end of the grid. X recycles tiles as you scroll, so what's on
  screen is only ever a window onto the results. The viewer keeps the whole
  list and walks straight through it.

• Video in place. It plays inside the viewer, with Space and M on the
  keyboard. No handoff to another view, no losing your position.

WHAT ELSE IT DOES

• Fullscreen viewing — scaled to fit, never cropped, never stretched
• Filmstrip — the active item stays centred, videos marked with their duration
• Shortlist — star what's worth keeping, then filter the filmstrip to those
• Compare — four starred items at once in a 2×2 grid
• Dimensions and author — always visible, and the author links to the post
• Copy and download — one key each, straight from the viewer
• Zoom and pan — scroll to zoom, Cmd/Ctrl-scroll or Shift-scroll to pan
• Click anywhere outside the image to close, or press Esc

KEYBOARD

← →      previous / next (hold to accelerate)
Space    play / pause video — stars the item when it's a photo
M        mute / unmute
S        star          Shift+S  show only starred
G        compare starred items
C        copy          D        download
F        hide the filmstrip
Esc      step back, then close

WORKS ON

• The Media tab of any search — search a term, then switch to Media
• Any profile's Media tab with Photos selected

IF YOU USE GOOGLE IMAGES

Monocle started there. Same viewer, same keyboard, built for Google Images
results — fullscreen browsing, shortlist and side-by-side compare without ever
landing on a host site:

Monocle | Google Images Fullscreen Viewer
https://chromewebstore.google.com/detail/monocle-google-images-ful/dgagakghpdbolgoodkbamjhgdmaphbcp

PRIVACY

Monocle for X has no accounts, no analytics and no tracking. Nothing you view
or search is recorded or transmitted anywhere. It runs entirely in your
browser, and it does not read, post, follow, like or change anything on your
account.

Media is fetched directly from X's own media servers, and only when you ask to
copy or download something.

NOT AFFILIATED

Monocle for X is an independent extension. It is not made by, endorsed by or
affiliated with X Corp. "X" is used only to say which site the extension works
on.

---

## Single purpose (required field)

Monocle for X provides a fullscreen viewer for media on X, letting users browse
a timeline's images and videos one item at a time with keyboard navigation, a
shortlist and side-by-side comparison, without closing and reopening the
viewer for each result.

---

## Permission justifications

**host permission — https://x.com/, https://twitter.com/**
The viewer runs on X's media timelines. The extension needs to read the media
records the page already carries in order to build the filmstrip, and to inject
its viewer UI there. twitter.com is included because X still serves the same
pages on the legacy domain.

**host permission — https://pbs.twimg.com/, https://video.twimg.com/**
X's own media servers, and the only two hosts the media itself comes from.
Access is needed to fetch an image's bytes for the copy action and the video
file for inline playback and download. The surface is small and known in
advance, so it is declared up front rather than requested later.

**downloads**
Powers the download action in the viewer, saving the currently displayed image
or video. Used only in response to the user pressing D or clicking the download
button.

**Remote code**: No. All code is contained in the extension package. Nothing is
loaded or executed from a remote source. Video plays in a standard HTML video
element using the file X already serves — there is no bundled or fetched player
library.

---

## Data usage disclosures

- Does the extension collect personally identifiable information? **No**
- Health information? **No**
- Financial and payment information? **No**
- Authentication information? **No**
- Personal communications? **No**
- Location? **No**
- Web history? **No**
- User activity? **No**
- Website content? **No** — page content is read in-memory to build the viewer
  and is never stored or transmitted.

Certifications:
- Does not sell or transfer user data to third parties ✔
- Does not use or transfer user data for purposes unrelated to the single purpose ✔
- Does not use or transfer user data to determine creditworthiness or for lending ✔

Privacy policy URL: required only if data were collected. None is collected.

---

## Screenshots (1280×800)

1. `01-main-viewer.png` — fullscreen viewer with filmstrip
2. `02-video.png` — video, duration badges in the filmstrip
3. `03-shortlist.png` — filmstrip filtered to starred items
4. `04-grid-compare.png` — 2×2 compare of starred items

Built the way Monocle's were: composed at 1440×900 in Figma (page
"Monocle for X — Store"), which is exactly 1.6, then rendered to 1280×800 as
a pure downscale. The background plate is a real capture of an X media grid
sitting UNDER the scrim — exporting the viewer frame alone is what forced the
redo last time, because the blur had nothing behind it. Imagery is from a
"modern coffee tables and sofas" media search, pulled at full resolution from
X's CDN. Author handles are anonymised to @example, as Monocle's were to
example.com.

---

## Open question for submission

The name "Monocle for X" is nominative use — it says which site the extension
works on, which is how the Web Store expects third-party extensions to be
named. The NOT AFFILIATED section above exists to make that explicit for
review. If review pushes back, the fallback is "Monocle for X (Unofficial)".

---

## Surface notes (verified 2026-10-27 on live X)

**Works.** Search Media grids, and a profile's Media tab with Photos selected
(`/<user>/media?filter=photo`). Verified on @NASA: the viewer opened with 59
items in the filmstrip, 16 of them videos, and a 3,840x2,160 clip played
inline at readyState 4.

**Does not engage.** A profile's Media tab now defaults to **Videos**, and that
view is not a grid at all -- it is a timeline of full post cards with no
`/status/<id>/photo/<n>` anchors anywhere. Confirmed on two accounts. Clicks
there fall through to X untouched, which is the correct behaviour; supporting
it would mean treating a timeline as a gallery, which is a different product.

An earlier draft of this file claimed profile media was unsupported outright.
That was wrong. It came from reaching /media by URL, landing on the Videos
default, and generalising from it without opening the dropdown. Photos grids
work, and always did.
