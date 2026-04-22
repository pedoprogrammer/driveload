const API_BASE = "https://driveload.onrender.com";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const setupView    = document.getElementById("setup-view");
const mainView     = document.getElementById("main-view");
const apiKeyInput  = document.getElementById("api-key-input");
const saveKeyBtn   = document.getElementById("save-key-btn");
const planBadge    = document.getElementById("plan-badge");
const urlDetect    = document.getElementById("url-detect");
const detectedUrl  = document.getElementById("detected-url");
const noUrl        = document.getElementById("no-url");
const cookiesStatus= document.getElementById("cookies-status");
const downloadBtn  = document.getElementById("download-btn");
const progressWrap = document.getElementById("progress-wrap");
const progressBar  = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const doneMsg      = document.getElementById("done-msg");
const downloadsLeft= document.getElementById("downloads-left");
const disconnectBtn= document.getElementById("disconnect-btn");

let currentUrl  = null;
let cookiesJson = null;

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(["apiKey", "userPlan", "downloadsUsed"], async (data) => {
  if (!data.apiKey) {
    show(setupView);
    return;
  }
  show(mainView);
  renderPlan(data.userPlan, data.downloadsUsed);
  await detectDriveUrl();
  await fetchCookies();
});

// ── Save API key ──────────────────────────────────────────────────────────────
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  saveKeyBtn.textContent = "Connecting...";
  saveKeyBtn.disabled = true;

  try {
    const res  = await fetch(`${API_BASE}/api/v1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({ url: "https://drive.google.com/" })
    });
    const data = await res.json();
    if (!data.ok && data.message === "Invalid API key") throw new Error("Invalid key");

    await chrome.storage.local.set({
      apiKey: key,
      userPlan: data.plan || "free",
      downloadsUsed: data.downloads_used || 0
    });
    location.reload();
  } catch (e) {
    saveKeyBtn.textContent = "Connect Account";
    saveKeyBtn.disabled = false;
    apiKeyInput.style.borderColor = "#ef4444";
    apiKeyInput.placeholder = "Invalid API key — try again";
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────
disconnectBtn.addEventListener("click", () => {
  chrome.storage.local.clear(() => location.reload());
});

// ── Detect active tab URL ─────────────────────────────────────────────────────
async function detectDriveUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const match = tab.url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (match) {
    currentUrl = tab.url;
    detectedUrl.textContent = tab.url;
    show(urlDetect);
    downloadBtn.disabled = false;
  } else {
    show(noUrl);
    downloadBtn.disabled = true;
  }
}

// ── Get Google cookies from browser ──────────────────────────────────────────
async function fetchCookies() {
  cookiesStatus.textContent = "Reading Google cookies...";
  try {
    const raw = await chrome.cookies.getAll({ domain: ".google.com" });
    if (!raw || raw.length === 0) {
      cookiesStatus.textContent = "No Google cookies found. Make sure you're logged into Google.";
      return;
    }
    // Format as the app expects: array of {name, value, domain, path}
    cookiesJson = raw.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path
    }));
    cookiesStatus.textContent = `✓ ${raw.length} Google cookies ready`;
    cookiesStatus.style.color = "#4ade80";
  } catch (e) {
    cookiesStatus.textContent = "Could not read cookies: " + e.message;
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
downloadBtn.addEventListener("click", async () => {
  if (!currentUrl) return;
  const { apiKey } = await chrome.storage.local.get("apiKey");

  downloadBtn.disabled = true;
  show(progressWrap);
  progressBar.style.width = "10%";
  progressText.textContent = "Sending to DriveLoad...";

  try {
    const res = await fetch(`${API_BASE}/api/v1/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ url: currentUrl, cookies: cookiesJson })
    });
    const data = await res.json();

    if (!data.ok) {
      progressText.textContent = data.message || "Error starting download";
      progressBar.style.background = "#ef4444";
      downloadBtn.disabled = false;
      return;
    }

    progressBar.style.width = "100%";
    hide(progressWrap);
    show(doneMsg);

    // Update cached plan info
    if (data.plan) {
      await chrome.storage.local.set({
        userPlan: data.plan,
        downloadsUsed: data.downloads_used || 0
      });
      renderPlan(data.plan, data.downloads_used || 0);
    }
  } catch (e) {
    progressText.textContent = "Network error. Is DriveLoad running?";
    progressBar.style.background = "#ef4444";
    downloadBtn.disabled = false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function renderPlan(plan, used) {
  planBadge.textContent = (plan || "free").toUpperCase();
  planBadge.className   = "badge badge-" + (plan === "pro" ? "pro" : "free");
  if (plan !== "pro") {
    const left = Math.max(0, 3 - (used || 0));
    downloadsLeft.textContent = `${left} free download${left !== 1 ? "s" : ""} remaining`;
  } else {
    downloadsLeft.textContent = "Unlimited downloads";
  }
}
