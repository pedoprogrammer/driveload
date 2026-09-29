const button = document.getElementById("download-btn");
const buttonLabel = document.getElementById("button-label");
const pageTitle = document.getElementById("page-title");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressValue = document.getElementById("progress-value");
const statusText = document.getElementById("status");
const message = document.getElementById("message");

let currentTab = null;
let busy = false;

Promise.all([
  chrome.tabs.query({active: true, currentWindow: true}),
  chrome.storage.local.get("downloadState")
]).then(([[tab], stored]) => {
  currentTab = tab;
  pageTitle.textContent = tab?.title || "Current browser tab";
  renderState(stored.downloadState);
  const supported = Boolean(tab?.url && /^https?:\/\//.test(tab.url));
  button.disabled = busy || !supported;
  if (!supported) showMessage("Open a public video page, then press the extension again.", true);
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.downloadState) renderState(changes.downloadState.newValue);
});

button.addEventListener("click", async () => {
  if (!currentTab?.url || busy) return;
  const mediaUrl = await discoverMediaUrl(currentTab.id, currentTab.url);
  const cookies = currentTab.url.includes("youtube.com")
    ? await chrome.cookies.getAll({url: currentTab.url})
    : [];
  await chrome.runtime.sendMessage({
    type: "start-download",
    url: mediaUrl,
    sourceUrl: currentTab.url,
    cookies: cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      expirationDate: cookie.expirationDate
    }))
  });
});

async function discoverMediaUrl(tabId, fallbackUrl) {
  try {
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId},
      world: "MAIN",
      func: () => {
        const candidates = [];
        const add = (url, score) => {
          if (!url || !/^https?:\/\//i.test(url)) return;
          candidates.push({url, score});
        };

        document.querySelectorAll("video,audio").forEach(media => {
          add(media.currentSrc, 80);
          add(media.src, 75);
        });
        document.querySelectorAll("video source,audio source").forEach(source => {
          add(source.src, 75);
        });
        document.querySelectorAll("iframe[src]").forEach(frame => add(frame.src, 30));

        performance.getEntriesByType("resource").forEach(entry => {
          const url = entry.name || "";
          if (/\/hls_manifest(?:\?|$)/i.test(url)) add(url, 120);
          else if (/\.m3u8(?:\?|$)/i.test(url)) {
            add(url, /hls_manifest_[va]_/i.test(url) ? 95 : 110);
          } else if (/\.mpd(?:\?|$)/i.test(url)) add(url, 105);
          else if (/\.(mp4|webm)(?:\?|$)/i.test(url) && !/\/seg_\d+/i.test(url)) add(url, 70);
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.url || null;
      }
    });
    return result || fallbackUrl;
  } catch (_error) {
    return fallbackUrl;
  }
}

function renderState(state) {
  if (!state) return;
  busy = Boolean(state.busy);
  button.disabled = busy || !currentTab?.url;
  buttonLabel.textContent = busy ? "Downloading..." : "Download video";
  progress.classList.toggle("hidden", !busy);
  const percent = Math.max(0, Math.min(100, Math.round(Number(state.progress) || 0)));
  progressFill.style.width = `${percent}%`;
  progressValue.textContent = `${percent}%`;
  statusText.textContent = state.status || "Downloading...";
  if (!busy && state.status) showMessage(state.status, Boolean(state.error));
}

function showMessage(text, isError) {
  message.textContent = text;
  message.className = `message ${isError ? "error" : "success"}`;
}
