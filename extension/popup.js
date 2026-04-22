const API_BASE = "https://driveload.onrender.com";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const setupView    = document.getElementById("setup-view");
const mainView     = document.getElementById("main-view");
const apiKeyInput  = document.getElementById("api-key-input");
const saveKeyBtn   = document.getElementById("save-key-btn");
const saveKeyLabel = document.getElementById("save-key-label");
const keyError     = document.getElementById("key-error");
const planPill     = document.getElementById("plan-pill");
const userName     = document.getElementById("user-name");
const userAvatar   = document.getElementById("user-avatar");
const quotaText    = document.getElementById("quota-text");
const urlFound     = document.getElementById("url-found");
const urlMissing   = document.getElementById("url-missing");
const urlDisplay   = document.getElementById("url-display");
const cookieRow    = document.getElementById("cookie-row");
const cookieText   = document.getElementById("cookie-text");
const downloadBtn  = document.getElementById("download-btn");
const dlLabel      = document.getElementById("dl-label");
const progressSec  = document.getElementById("progress-section");
const progressFill = document.getElementById("progress-fill");
const progressLbl  = document.getElementById("progress-label");
const successMsg   = document.getElementById("success-msg");
const disconnectBtn= document.getElementById("disconnect-btn");

let currentUrl  = null;
let cookiesData = null;

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(["apiKey", "userData"], async (data) => {
  if (!data.apiKey) {
    show(setupView);
    return;
  }
  show(mainView);
  if (data.userData) renderUser(data.userData);
  await detectDriveUrl();
  await fetchCookies();
});

// ── Save API key ──────────────────────────────────────────────────────────────
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { shakeInput(); return; }

  setLoading(true);
  hide(keyError);
  apiKeyInput.classList.remove("error");

  try {
    const res = await fetch(`${API_BASE}/api/v1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({})
    });

    if (res.status === 401) throw new Error("invalid");
    const data = await res.json();
    if (!data.ok) throw new Error("invalid");

    const userData = {
      plan:           data.plan || "free",
      downloadsUsed:  data.downloads_used || 0
    };

    await chrome.storage.local.set({ apiKey: key, userData });
    location.reload();

  } catch (e) {
    setLoading(false);
    apiKeyInput.classList.add("error");
    show(keyError);
    if (e.message !== "invalid") {
      keyError.textContent = "Could not connect to DriveLoad. Check your internet connection.";
    } else {
      keyError.textContent = "Invalid API key. Please check and try again.";
    }
  }
});

function setLoading(on) {
  saveKeyBtn.disabled  = on;
  saveKeyLabel.textContent = on ? "Connecting…" : "Connect Account";
}

function shakeInput() {
  apiKeyInput.style.animation = "none";
  setTimeout(() => { apiKeyInput.style.animation = ""; }, 10);
  apiKeyInput.classList.add("error");
  setTimeout(() => apiKeyInput.classList.remove("error"), 1500);
}

// ── Disconnect ────────────────────────────────────────────────────────────────
disconnectBtn.addEventListener("click", () => {
  chrome.storage.local.clear(() => location.reload());
});

// ── Render user info ──────────────────────────────────────────────────────────
function renderUser(ud) {
  const plan = ud.plan || "free";
  const used = ud.downloadsUsed || 0;

  planPill.textContent  = plan.toUpperCase();
  planPill.className    = "plan-pill " + (plan === "pro" ? "plan-pro" : "plan-free");
  show(planPill);

  userAvatar.textContent = plan === "pro" ? "★" : "U";
  userName.textContent   = plan === "pro" ? "Pro Member" : "Free Plan";

  if (plan === "pro") {
    quotaText.textContent = "Unlimited downloads";
  } else {
    const left = Math.max(0, 3 - used);
    quotaText.textContent = `${left} of 3 free downloads remaining`;
  }
}

// ── Detect active tab URL ─────────────────────────────────────────────────────
async function detectDriveUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { show(urlMissing); return; }

  // Match any Google Drive/Docs/Sheets/Slides file
  const match = tab.url.match(
    /(?:drive\.google\.com\/file\/d\/|docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/)([a-zA-Z0-9_-]+)/
  );
  if (match) {
    currentUrl = tab.url;
    urlDisplay.textContent = tab.url;
    show(urlFound);
    downloadBtn.disabled = false;
    // Label based on file type
    if      (tab.url.includes("/document/"))     dlLabel.textContent = "⬇ Download as Word";
    else if (tab.url.includes("/spreadsheets/")) dlLabel.textContent = "⬇ Download as Excel";
    else if (tab.url.includes("/presentation/")) dlLabel.textContent = "⬇ Download as PowerPoint";
    else                                          dlLabel.textContent = "⬇ Download File";
  } else {
    show(urlMissing);
    downloadBtn.disabled = true;
  }
}

// ── Fetch Google cookies ──────────────────────────────────────────────────────
async function fetchCookies() {
  cookieText.textContent = "Reading Google cookies…";
  try {
    const raw = await chrome.cookies.getAll({ domain: ".google.com" });
    if (!raw || raw.length === 0) {
      cookieText.textContent = "No Google cookies — make sure you're logged into Google.";
      cookieText.className = "info-text info-warn";
      return;
    }
    cookiesData = raw.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    cookieText.textContent = `${raw.length} Google cookies ready`;
    cookieText.className = "info-text info-ok";
  } catch (e) {
    cookieText.textContent = "Could not read cookies: " + e.message;
    cookieText.className = "info-text info-warn";
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
downloadBtn.addEventListener("click", async () => {
  if (!currentUrl) return;
  const { apiKey } = await chrome.storage.local.get("apiKey");

  downloadBtn.disabled = true;
  dlLabel.textContent  = "Sending…";
  show(progressSec);
  progressFill.style.width = "15%";
  progressLbl.textContent  = "Connecting to DriveLoad…";

  try {
    const res = await fetch(`${API_BASE}/api/v1/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ url: currentUrl, cookies: cookiesData })
    });

    const data = await res.json();

    if (!data.ok) {
      progressFill.style.width = "100%";
      progressFill.style.background = "#ef4444";
      progressLbl.textContent = data.message || "Something went wrong.";
      dlLabel.textContent = "⬇ Download Video";
      downloadBtn.disabled = false;
      return;
    }

    progressFill.style.width = "100%";
    setTimeout(() => {
      hide(progressSec);
      show(successMsg);
    }, 600);

    // Refresh cached user data
    const statusRes = await fetch(`${API_BASE}/api/v1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({})
    });
    if (statusRes.ok) {
      const sd = await statusRes.json();
      const userData = { plan: sd.plan || "free", downloadsUsed: sd.downloads_used || 0 };
      await chrome.storage.local.set({ userData });
      renderUser(userData);
    }

  } catch (e) {
    progressFill.style.background = "#ef4444";
    progressLbl.textContent = "Network error — is DriveLoad reachable?";
    dlLabel.textContent = "⬇ Download Video";
    downloadBtn.disabled = false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
