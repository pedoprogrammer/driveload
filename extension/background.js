const API_BASE = "https://driveload.duckdns.org";
const POLL_ALARM = "driveload-poll";
let fastPollRunning = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "start-download") {
    startDownload(message.url, message.cookies || [], message.sourceUrl || message.url,
                  message.filename || "");
    sendResponse({ok: true});
    return false;
  }
  if (message?.type === "control-download") {
    controlDownload(message.action);
    sendResponse({ok: true});
    return false;
  }
  if (message?.type === "poll-now") {
    pollOnce();
    startFastPolling();
    sendResponse({ok: true});
    return false;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) pollOnce();
});

chrome.runtime.onStartup.addListener(restorePolling);
chrome.runtime.onInstalled.addListener(restorePolling);

async function restorePolling() {
  const {activeJob} = await chrome.storage.local.get("activeJob");
  if (activeJob?.jobId) {
    await ensureAlarm();
    startFastPolling();
  } else {
    const {downloadState} = await chrome.storage.local.get("downloadState");
    if (downloadState?.busy) {
      await setState({busy: false, paused: false, error: false, progress: 0,
                      status: "Ready for a new download."});
    }
  }
}

async function startDownload(url, cookies, sourceUrl, requestedFilename) {
  requestedFilename = cleanFilename(requestedFilename);
  await setState({busy: true, paused: false, progress: 1,
                  status: "Reading this page...", error: false,
                  requestedFilename});
  try {
    const response = await fetch(`${API_BASE}/api/v1/guest/download`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, cookies, source_url: sourceUrl})
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not start download");
    await chrome.storage.local.set({activeJob: {jobId: result.job_id, requestedFilename}});
    await ensureAlarm();
    startFastPolling();
  } catch (error) {
    await failJob(error.message);
  }
}

async function controlDownload(action) {
  const {activeJob} = await chrome.storage.local.get("activeJob");
  if (!activeJob?.jobId) return;
  if (action === "pause") {
    await setState({busy: true, paused: true, progress: activeJob.progress || 1,
                    status: "Pausing...", error: false});
  } else if (action === "resume") {
    await setState({busy: true, paused: false, progress: activeJob.progress || 1,
                    status: "Resuming...", error: false});
  } else if (action === "cancel") {
    await setState({busy: true, paused: false, cancelling: true,
                    progress: activeJob.progress || 1,
                    status: "Cancelling...", error: false});
  }
  try {
    const response = await fetch(`${API_BASE}/api/v1/guest/control/${activeJob.jobId}`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({action})
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not update download");
    await pollOnce();
    startFastPolling();
  } catch (error) {
    await setState({busy: true, paused: action !== "cancel", error: false,
                    progress: activeJob.progress || 0,
                    status: cleanError(error.message)});
  }
}

async function pollOnce() {
  const {activeJob} = await chrome.storage.local.get("activeJob");
  if (!activeJob?.jobId) return false;
  try {
    const response = await fetch(`${API_BASE}/api/v1/guest/status/${activeJob.jobId}`);
    const result = await response.json();
    if (!response.ok || !result.ok || result.error) {
      throw new Error(result.message || result.status || "Download failed");
    }
    const progress = Math.max(0, Math.min(100, Number(result.progress) || 0));
    if (result.cancelled) {
      await chrome.storage.local.remove("activeJob");
      await chrome.alarms.clear(POLL_ALARM);
      await setState({busy: false, paused: false, error: false, progress: 0,
                      status: "Download cancelled."});
      return false;
    }
    if (result.ready) {
      const filename = finalFilename(activeJob.requestedFilename, result.filename);
      await chrome.storage.local.remove("activeJob");
      await chrome.alarms.clear(POLL_ALARM);
      await chrome.downloads.download({
        url: `${API_BASE}/api/v1/guest/file/${activeJob.jobId}`,
        filename,
        saveAs: false
      });
      await setState({busy: false, paused: false, error: false, progress: 100,
                      requestedFilename: activeJob.requestedFilename || "",
                      status: `Saved as ${filename}`});
      return false;
    }
    await chrome.storage.local.set({activeJob: {...activeJob, progress}});
    await setState({
      busy: true,
      paused: Boolean(result.paused),
      cancelling: false,
      error: false,
      progress,
      status: result.status || "Downloading...",
      downloadedBytes: result.downloaded_bytes || 0,
      totalBytes: result.total_bytes || 0,
      speed: result.speed || 0,
      eta: result.eta,
      format: result.format || "",
      resolution: result.resolution || ""
    });
    return !result.paused;
  } catch (error) {
    await failJob(error.message);
    return false;
  }
}

async function startFastPolling() {
  if (fastPollRunning) return;
  fastPollRunning = true;
  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (!(await pollOnce())) return;
    }
  } finally {
    fastPollRunning = false;
  }
}

async function ensureAlarm() {
  await chrome.alarms.create(POLL_ALARM, {periodInMinutes: 0.5});
}

async function failJob(message) {
  await chrome.storage.local.remove("activeJob");
  await chrome.alarms.clear(POLL_ALARM);
  await setState({busy: false, paused: false, error: true,
                  status: cleanError(message), progress: 0});
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

function cleanFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function finalFilename(requested, automatic) {
  const fallback = cleanFilename(automatic) || "video.mp4";
  const custom = cleanFilename(requested);
  if (!custom) return fallback;
  if (/\.[a-z0-9]{2,5}$/i.test(custom)) return custom;
  const extension = fallback.match(/(\.[a-z0-9]{2,5})$/i)?.[1] || ".mp4";
  return `${custom}${extension}`;
}
