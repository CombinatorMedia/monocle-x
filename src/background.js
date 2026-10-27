chrome.action.onClicked.addListener((tab) => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'mx-open-toolbar' });
});

// Runs in the background service worker specifically because fetches from
// here, with host_permissions for the target origin, bypass CORS — a content
// script's fetch() is still bound by the page's own CORS rules and silently
// fails on third-party image hosts that don't send CORS headers (which is
// most of them). We only need the bytes here; the actual clipboard write has
// to happen back in the content script, since service workers have no
// clipboard/DOM access.
async function fetchImageAsDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// On X every media file is on one of two known hosts — pbs.twimg.com for
// photos and posters, video.twimg.com for video — so both are declared in
// host_permissions and the fetch below always has access. Monocle needed an
// optional "all hosts" grant because Google Images can point anywhere; here
// the surface is small enough to ask for up front and never prompt again.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'mx-download' && message.url) {
    chrome.downloads.download({ url: message.url });
    return false;
  }
  if (message.type === 'mx-fetch-image' && message.url) {
    fetchImageAsDataUrl(message.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
  return false;
});
