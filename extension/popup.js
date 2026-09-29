const button = document.getElementById("download-btn");
const buttonLabel = document.getElementById("button-label");
const pageTitle = document.getElementById("page-title");
const filenameInput = document.getElementById("filename");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressValue = document.getElementById("progress-value");
const statusText = document.getElementById("status");
const downloadedSize = document.getElementById("downloaded-size");
const totalSize = document.getElementById("total-size");
const downloadSpeed = document.getElementById("download-speed");
const downloadEta = document.getElementById("download-eta");
const mediaFormat = document.getElementById("media-format");
const mediaResolution = document.getElementById("media-resolution");
const message = document.getElementById("message");
const pauseButton = document.getElementById("pause-btn");
const pauseIcon = document.getElementById("pause-icon");
const pauseLabel = document.getElementById("pause-label");
const cancelButton = document.getElementById("cancel-btn");

let currentTab = null;
let busy = false;

Promise.all([
  chrome.tabs.query({active: true, currentWindow: true}),
  chrome.storage.local.get("downloadState")
]).then(([[tab], stored]) => {
  currentTab = tab;
  pageTitle.textContent = tab?.title || "Current browser tab";
  filenameInput.value = stored.downloadState?.requestedFilename
    || suggestedFilename(tab?.title || "video");
  renderState(stored.downloadState);
  const supported = Boolean(tab?.url && /^https?:\/\//.test(tab.url));
  button.disabled = busy || !supported;
  if (!supported) showMessage("Open a public video page, then press the extension again.", true);
  chrome.runtime.sendMessage({type: "poll-now"});
});

pauseButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({type: "control-download", action: pauseButton.dataset.action});
});

cancelButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({type: "control-download", action: "cancel"});
});

chrome.storage.onChanged.addListener(changes => {
  if (changes.downloadState) renderState(changes.downloadState.newValue);
});

button.addEventListener("click", async () => {
  if (!currentTab?.url || busy) return;
  message.className = "message hidden";
  message.textContent = "";
  const mediaUrl = await discoverMediaUrl(currentTab.id, currentTab.url);
  const cookies = currentTab.url.includes("youtube.com")
    ? await chrome.cookies.getAll({url: currentTab.url})
    : [];
  await chrome.runtime.sendMessage({
    type: "start-download",
    url: mediaUrl,
    sourceUrl: currentTab.url,
    filename: filenameInput.value,
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
  filenameInput.disabled = busy;
  buttonLabel.textContent = busy ? "Downloading..." : "Download video";
  progress.classList.toggle("hidden", !busy);
  const paused = Boolean(state.paused);
  pauseButton.dataset.action = paused ? "resume" : "pause";
  pauseIcon.textContent = paused ? "▶" : "Ⅱ";
  pauseLabel.textContent = paused ? "Resume" : "Pause";
  cancelButton.disabled = Boolean(state.cancelling);
  const percent = Math.max(0, Math.min(100, Math.round(Number(state.progress) || 0)));
  progressFill.style.width = `${percent}%`;
  progressValue.textContent = `${percent}%`;
  statusText.textContent = String(state.status || "Downloading...")
    .replace(/\s+\d+(?:\.\d+)?%$/, "");
  downloadedSize.textContent = formatBytes(state.downloadedBytes) || "Starting...";
  totalSize.textContent = formatBytes(state.totalBytes) || "Estimating...";
  downloadSpeed.textContent = state.speed ? `${formatBytes(state.speed)}/s` : "--";
  downloadEta.textContent = formatDuration(state.eta);
  mediaFormat.textContent = String(state.format || "Detecting...").toUpperCase();
  mediaResolution.textContent = state.resolution || "Detecting...";
  if (busy) {
    message.className = "message hidden";
    message.textContent = "";
  } else if (state.status) {
    showMessage(state.status, Boolean(state.error));
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  if (!seconds) return "--";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function suggestedFilename(title) {
  const cleaned = String(title || "video")
    .replace(/\s+-\s+YouTube\s*$/i, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "video";
}

function showMessage(text, isError) {
  message.textContent = text;
  message.className = `message ${isError ? "error" : "success"}`;
}
