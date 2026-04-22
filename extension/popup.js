const API_BASE = "https://driveload.onrender.com";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const setupView     = document.getElementById("setup-view");
const mainView      = document.getElementById("main-view");
const apiKeyInput   = document.getElementById("api-key-input");
const saveKeyBtn    = document.getElementById("save-key-btn");
const saveKeyLabel  = document.getElementById("save-key-label");
const keyError      = document.getElementById("key-error");
const planPill      = document.getElementById("plan-pill");
const userAvatar    = document.getElementById("user-avatar");
const userName      = document.getElementById("user-name");
const quotaText     = document.getElementById("quota-text");
const disconnectBtn = document.getElementById("disconnect-btn");
const urlInput      = document.getElementById("url-input");

// tabs
const tabPdf        = document.getElementById("tab-pdf");
const tabApi        = document.getElementById("tab-api");
const panelPdf      = document.getElementById("panel-pdf");
const panelApi      = document.getElementById("panel-api");

// pdf panel
const cookieTextPdf  = document.getElementById("cookie-text-pdf");
const cookieRowPdf   = document.getElementById("cookie-row-pdf");
const downloadPdfBtn = document.getElementById("download-pdf-btn");

// api panel
const cookieTextApi  = document.getElementById("cookie-text-api");
const downloadApiBtn = document.getElementById("download-api-btn");

// shared
const progressSec   = document.getElementById("progress-section");
const progressFill  = document.getElementById("progress-fill");
const progressLbl   = document.getElementById("progress-label");
const successMsg    = document.getElementById("success-msg");
const successTitle  = document.getElementById("success-title");
const successSub    = document.getElementById("success-sub");
const errorMsg      = document.getElementById("error-msg");

let currentTab  = null;
let cookiesData = null;

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(["apiKey", "userData"], async (data) => {
  if (!data.apiKey) { show(setupView); return; }
  show(mainView);
  if (data.userData) renderUser(data.userData);
  await detectTab();
  await loadCookies();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
[tabPdf, tabApi].forEach(tab => {
  tab.addEventListener("click", () => {
    [tabPdf, tabApi].forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const mode = tab.dataset.mode;
    panelPdf.classList.toggle("hidden", mode !== "pdf");
    panelApi.classList.toggle("hidden", mode !== "api");
    hideResult();
  });
});

// ── Connect API key ───────────────────────────────────────────────────────────
saveKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { apiKeyInput.classList.add("error"); return; }
  saveKeyLabel.textContent = "Connecting…";
  saveKeyBtn.disabled = true;
  hide(keyError);
  try {
    const res = await fetch(`${API_BASE}/api/v1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify({})
    });
    if (res.status === 401) throw new Error("invalid");
    const data = await res.json();
    if (!data.ok) throw new Error("invalid");
    await chrome.storage.local.set({
      apiKey: key,
      userData: { plan: data.plan || "free", downloadsUsed: data.downloads_used || 0 }
    });
    location.reload();
  } catch (e) {
    saveKeyLabel.textContent = "Connect Account";
    saveKeyBtn.disabled = false;
    apiKeyInput.classList.add("error");
    keyError.textContent = e.message === "invalid"
      ? "Invalid API key. Please check and try again."
      : "Cannot connect to DriveLoad. Check your internet.";
    show(keyError);
  }
});

disconnectBtn.addEventListener("click", () => chrome.storage.local.clear(() => location.reload()));

// ── Detect current tab ────────────────────────────────────────────────────────
async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTab = tab;
  if (tab.url && tab.url.includes("google.com")) {
    urlInput.value = tab.url;
  }
}

// ── Load Google cookies ───────────────────────────────────────────────────────
async function loadCookies() {
  try {
    const raw = await chrome.cookies.getAll({ domain: ".google.com" });
    if (raw && raw.length > 0) {
      cookiesData = raw.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
      cookieTextApi.textContent = `✓ ${raw.length} Google cookies ready`;
      cookieTextApi.className   = "info-text info-ok";
      show(cookieRowPdf);
      cookieTextPdf.textContent = `✓ ${raw.length} cookies for auth`;
      cookieTextPdf.className   = "info-text info-ok";
    } else {
      cookieTextApi.textContent = "No Google cookies found — log into Google first";
      cookieTextApi.className   = "info-text info-warn";
    }
  } catch (e) {
    cookieTextApi.textContent = "Could not read cookies: " + e.message;
    cookieTextApi.className   = "info-text info-warn";
  }
}

// ── Render user ───────────────────────────────────────────────────────────────
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

// ── PDF download (browser-side blob extraction) ───────────────────────────────
downloadPdfBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url || !url.includes("google.com")) {
    showError("Please enter a valid Google Drive URL above."); return;
  }

  // Make sure we're on the right tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes("google.com")) {
    showError("Please open the PDF in Google Drive viewer first, then click here."); return;
  }

  hideResult();
  downloadPdfBtn.disabled = true;
  show(progressSec);
  progressFill.style.width    = "5%";
  progressFill.style.background = "";
  progressLbl.textContent     = "Injecting PDF downloader…";

  try {
    // Inject jsPDF into page main world
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["vendor/jspdf.min.js"],
      world:  "MAIN"
    });

    // Reset any previous status
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   () => { window.__driveload_status = null; },
      world:  "MAIN"
    });

    // Run PDF downloader
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files:  ["pdf_downloader.js"],
      world:  "MAIN"
    });

    // Poll for status updates
    await pollPDFStatus(tab.id);

  } catch (e) {
    showError("Could not inject script: " + e.message +
      "\n\nMake sure you're on a Google Drive page and reloaded the extension.");
    downloadPdfBtn.disabled = false;
  }
});

async function pollPDFStatus(tabId) {
  return new Promise((resolve) => {
    const poll = setInterval(async () => {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func:   () => window.__driveload_status,
          world:  "MAIN"
        });
        const st = res?.result;
        if (!st) return; // not started yet

        progressFill.style.width = (st.progress || 0) + "%";
        progressLbl.textContent  = st.message || "Processing…";

        if (st.error) {
          clearInterval(poll);
          showError(st.error);
          downloadPdfBtn.disabled = false;
          resolve();
        } else if (st.done) {
          clearInterval(poll);
          hide(progressSec);
          successTitle.textContent = "PDF downloaded!";
          successSub.textContent   = "Check your browser Downloads folder.";
          show(successMsg);
          downloadPdfBtn.disabled = false;
          resolve();
        }
      } catch (_) { /* tab may have navigated */ }
    }, 700);
  });
}

// ── API / Server download ─────────────────────────────────────────────────────
downloadApiBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url || !url.includes("google.com")) {
    showError("Please enter a valid Google Drive URL above."); return;
  }

  const { apiKey } = await chrome.storage.local.get("apiKey");
  hideResult();
  downloadApiBtn.disabled = true;
  show(progressSec);
  progressFill.style.width    = "15%";
  progressFill.style.background = "";
  progressLbl.textContent     = "Connecting to DriveLoad server…";

  try {
    const res = await fetch(`${API_BASE}/api/v1/download`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body:    JSON.stringify({ url, cookies: cookiesData })
    });
    const data = await res.json();

    if (!data.ok) {
      progressFill.style.background = "#ef4444";
      progressLbl.textContent = data.message || "Server error.";
      downloadApiBtn.disabled = false;
      return;
    }

    progressFill.style.width = "100%";
    setTimeout(() => {
      hide(progressSec);
      successTitle.textContent = "Download started!";
      successSub.textContent   = "The file will appear in your DriveLoad dashboard when ready.";
      show(successMsg);
    }, 500);

    downloadApiBtn.disabled = false;

    // Refresh user data
    try {
      const sr = await fetch(`${API_BASE}/api/v1/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
        body: JSON.stringify({})
      });
      if (sr.ok) {
        const sd = await sr.json();
        await chrome.storage.local.set({
          userData: { plan: sd.plan || "free", downloadsUsed: sd.downloads_used || 0 }
        });
        renderUser({ plan: sd.plan, downloadsUsed: sd.downloads_used });
      }
    } catch (_) {}

  } catch (e) {
    showError("Network error — " + e.message);
    downloadApiBtn.disabled = false;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function showError(msg) {
  hide(progressSec);
  errorMsg.textContent = msg;
  show(errorMsg);
}
function hideResult() {
  hide(successMsg);
  hide(errorMsg);
  hide(progressSec);
  progressFill.style.width = "0%";
  progressFill.style.background = "";
}
