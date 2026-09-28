const API_BASE = "https://driveload.duckdns.org";
const button = document.getElementById("download-btn");
const buttonLabel = document.getElementById("button-label");
const pageTitle = document.getElementById("page-title");
const progress = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const statusText = document.getElementById("status");
const message = document.getElementById("message");

let currentTab = null;

chrome.tabs.query({active: true, currentWindow: true}, ([tab]) => {
  currentTab = tab;
  const supported = Boolean(tab?.url && /^https?:\/\//.test(tab.url));
  pageTitle.textContent = tab?.title || "Current browser tab";
  button.disabled = !supported;
  if (!supported) showMessage("Open a public video page, then press the extension again.", true);
});

button.addEventListener("click", async () => {
  if (!currentTab?.url) return;
  setBusy(true);
  try {
    const response = await fetch(`${API_BASE}/api/v1/guest/download`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url: currentTab.url})
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not start download");
    await waitForDownload(result.job_id);
  } catch (error) {
    setBusy(false);
    showMessage(cleanError(error.message), true);
  }
});

async function waitForDownload(jobId) {
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const response = await fetch(`${API_BASE}/api/v1/guest/status/${jobId}`);
    const result = await response.json();
    if (!response.ok || !result.ok || result.error) {
      throw new Error(result.message || result.status || "Download failed");
    }
    const percent = Math.max(2, Math.min(100, Number(result.progress) || 2));
    progressFill.style.width = `${percent}%`;
    statusText.textContent = result.status || "Downloading...";
    if (result.ready) {
      await chrome.downloads.download({
        url: `${API_BASE}/api/v1/guest/file/${jobId}`,
        filename: result.filename || undefined,
        saveAs: false
      });
      setBusy(false);
      showMessage("Saved to your Chrome Downloads folder.", false);
      buttonLabel.textContent = "Download again";
      return;
    }
  }
}

function setBusy(busy) {
  button.disabled = busy;
  progress.classList.toggle("hidden", !busy);
  message.classList.add("hidden");
  if (busy) {
    buttonLabel.textContent = "Downloading...";
    progressFill.style.width = "2%";
    statusText.textContent = "Reading this page...";
  }
}

function showMessage(text, isError) {
  message.textContent = text;
  message.className = `message ${isError ? "error" : "success"}`;
}

function cleanError(text) {
  return String(text || "Download failed")
    .replace(/^ERROR:\s*/i, "")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .trim();
}
