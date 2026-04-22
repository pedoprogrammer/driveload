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
let currentTab  = null;
let downloadMode = "api"; // "api" | "pdf"

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(["apiKey", "userData"], async (data) => {
  if (!data.apiKey) { show(setupView); return; }
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
    const userData = { plan: data.plan || "free", downloadsUsed: data.downloads_used || 0 };
    await chrome.storage.local.set({ apiKey: key, userData });
    location.reload();
  } catch (e) {
    setLoading(false);
    apiKeyInput.classList.add("error");
    show(keyError);
    keyError.textContent = e.message === "invalid"
      ? "Invalid API key. Please check and try again."
      : "Could not connect to DriveLoad. Check your internet.";
  }
});

function setLoading(on) {
  saveKeyBtn.disabled = on;
  saveKeyLabel.textContent = on ? "Connecting…" : "Connect Account";
}
function shakeInput() {
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
  planPill.textContent = plan.toUpperCase();
  planPill.className   = "plan-pill " + (plan === "pro" ? "plan-pro" : "plan-free");
  show(planPill);
  userAvatar.textContent = plan === "pro" ? "★" : "U";
  userName.textContent   = plan === "pro" ? "Pro Member" : "Free Plan";
  quotaText.textContent  = plan === "pro"
    ? "Unlimited downloads"
    : `${Math.max(0, 3 - used)} of 3 free downloads remaining`;
}

// ── Detect active tab URL ─────────────────────────────────────────────────────
async function detectDriveUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { show(urlMissing); return; }
  currentTab = tab;

  // Match Drive files and Google Workspace files
  const driveFile  = tab.url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  const docsFile   = tab.url.match(/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/([a-zA-Z0-9_-]+)/);

  if (driveFile || docsFile) {
    currentUrl = tab.url;
    urlDisplay.textContent = tab.url;
    show(urlFound);

    // Decide download mode
    if (docsFile) {
      const dtype = docsFile[1];
      if (dtype === "document")     { dlLabel.textContent = "⬇ Download as Word (.docx)"; downloadMode = "api"; }
      else if (dtype === "spreadsheets") { dlLabel.textContent = "⬇ Download as Excel (.xlsx)"; downloadMode = "api"; }
      else if (dtype === "presentation") { dlLabel.textContent = "⬇ Download as PowerPoint (.pptx)"; downloadMode = "api"; }
      else                          { dlLabel.textContent = "⬇ Download File"; downloadMode = "api"; }
    } else {
      // Drive file — detect if it's likely a PDF by checking the page title
      const isPDF = tab.title && (tab.title.toLowerCase().includes(".pdf") || tab.url.includes("pdf"));
      if (isPDF) {
        dlLabel.textContent = "⬇ Download PDF (from viewer)";
        downloadMode = "pdf";
      } else {
        dlLabel.textContent = "⬇ Download File";
        downloadMode = "api";
      }
    }
    downloadBtn.disabled = false;
  } else {
    show(urlMissing);
    downloadBtn.disabled = true;
  }
}

// ── Fetch Google cookies ──────────────────────────────────────────────────────
async function fetchCookies() {
  if (downloadMode === "pdf") {
    // PDF mode doesn't need manually fetched cookies — browser session handles it
    cookieText.textContent = "PDF mode: uses your active Google session";
    cookieText.className   = "info-text info-ok";
    return;
  }
  cookieText.textContent = "Reading Google cookies…";
  try {
    const raw = await chrome.cookies.getAll({ domain: ".google.com" });
    if (!raw || raw.length === 0) {
      cookieText.textContent = "No Google cookies — make sure you're logged into Google.";
      cookieText.className   = "info-text info-warn";
      return;
    }
    cookiesData = raw.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
    cookieText.textContent = `${raw.length} Google cookies ready`;
    cookieText.className   = "info-text info-ok";
  } catch (e) {
    cookieText.textContent = "Could not read cookies: " + e.message;
    cookieText.className   = "info-text info-warn";
  }
}

// ── Download ──────────────────────────────────────────────────────────────────
downloadBtn.addEventListener("click", async () => {
  if (!currentUrl) return;

  if (downloadMode === "pdf") {
    await startPDFDownload();
  } else {
    await startAPIDownload();
  }
});

// PDF download — inject jsPDF + downloader into page
async function startPDFDownload() {
  downloadBtn.disabled = true;
  show(progressSec);
  progressFill.style.width = "5%";
  progressFill.style.background = "";
  progressLbl.textContent  = "Injecting PDF downloader…";

  try {
    // Inject jsPDF into the page's main world
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files:  ["vendor/jspdf.min.js"],
      world:  "MAIN"
    });

    // Inject and run the PDF downloader
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      files:  ["pdf_downloader.js"],
      world:  "MAIN"
    });

    // Poll __driveload_status from the page
    progressLbl.textContent = "Scrolling through pages…";
    await pollPDFStatus();

  } catch (e) {
    progressFill.style.background = "#ef4444";
    progressLbl.textContent = "Error: " + e.message;
    downloadBtn.disabled = false;
  }
}

async function pollPDFStatus() {
  const poll = setInterval(async () => {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func:   () => window.__driveload_status,
        world:  "MAIN"
      });
      const st = result?.result;
      if (!st) return;

      progressFill.style.width = (st.progress || 0) + "%";
      progressLbl.textContent  = st.message || "Processing…";

      if (st.error) {
        clearInterval(poll);
        progressFill.style.background = "#ef4444";
        progressLbl.textContent = st.error;
        downloadBtn.disabled = false;
      } else if (st.done) {
        clearInterval(poll);
        hide(progressSec);
        show(successMsg);
        document.querySelector(".success-title").textContent = "PDF downloaded!";
        document.querySelector(".success-sub").textContent   = "Check your Downloads folder.";
      }
    } catch (_) {}
  }, 600);
}

// API download — sends to DriveLoad server
async function startAPIDownload() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  downloadBtn.disabled = true;
  dlLabel.textContent  = "Sending…";
  show(progressSec);
  progressFill.style.width = "15%";
  progressFill.style.background = "";
  progressLbl.textContent  = "Connecting to DriveLoad…";

  try {
    const res = await fetch(`${API_BASE}/api/v1/download`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body:    JSON.stringify({ url: currentUrl, cookies: cookiesData })
    });
    const data = await res.json();

    if (!data.ok) {
      progressFill.style.background = "#ef4444";
      progressLbl.textContent = data.message || "Something went wrong.";
      dlLabel.textContent = "⬇ Download File";
      downloadBtn.disabled = false;
      return;
    }

    progressFill.style.width = "100%";
    setTimeout(() => { hide(progressSec); show(successMsg); }, 600);

    // Refresh user data
    const sr = await fetch(`${API_BASE}/api/v1/status`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body:    JSON.stringify({})
    });
    if (sr.ok) {
      const sd = await sr.json();
      const userData = { plan: sd.plan || "free", downloadsUsed: sd.downloads_used || 0 };
      await chrome.storage.local.set({ userData });
      renderUser(userData);
    }
  } catch (e) {
    progressFill.style.background = "#ef4444";
    progressLbl.textContent = "Network error — is DriveLoad reachable?";
    dlLabel.textContent = "⬇ Download File";
    downloadBtn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
