const API_BASE = "https://driveload.duckdns.org";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "start-download") return false;
  startDownload(message.url, message.cookies || [], message.sourceUrl || message.url);
  sendResponse({ok: true});
  return false;
});

async function startDownload(url, cookies, sourceUrl) {
  await setState({busy: true, progress: 2, status: "Reading this page...", error: false});
  try {
    const response = await fetch(`${API_BASE}/api/v1/guest/download`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, cookies, source_url: sourceUrl})
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not start download");
    await poll(result.job_id);
  } catch (error) {
    await setState({busy: false, error: true, status: cleanError(error.message), progress: 0});
  }
}

async function poll(jobId) {
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    const response = await fetch(`${API_BASE}/api/v1/guest/status/${jobId}`);
    const result = await response.json();
    if (!response.ok || !result.ok || result.error) {
      throw new Error(result.message || result.status || "Download failed");
    }
    await setState({
      busy: !result.ready,
      error: false,
      progress: Math.max(2, Math.min(100, Number(result.progress) || 2)),
      status: result.status || "Downloading..."
    });
    if (result.ready) {
      await chrome.downloads.download({
        url: `${API_BASE}/api/v1/guest/file/${jobId}`,
        filename: result.filename || undefined,
        saveAs: false
      });
      await setState({busy: false, error: false, progress: 100,
                      status: "Saved to your Chrome Downloads folder."});
      return;
    }
  }
}

async function setState(state) {
  await chrome.storage.local.set({downloadState: state});
}

function cleanError(text) {
  return String(text || "Download failed")
    .replace(/^ERROR:\s*/i, "")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .trim();
}
