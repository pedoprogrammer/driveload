/**
 * DriveLoad PDF Downloader
 * Runs in the MAIN world of the Google Drive PDF viewer.
 * Scrolls through all pages, collects blob images, rebuilds as PDF using jsPDF.
 */
(async function driveloadPDF() {
  // ── 1. Notify popup we started ─────────────────────────────────────────────
  window.__driveload_status = { running: true, progress: 0, message: "Starting…", error: null, done: false };

  function setStatus(msg, pct) {
    window.__driveload_status.message  = msg;
    window.__driveload_status.progress = pct || 0;
  }
  function setError(msg) {
    window.__driveload_status.error   = msg;
    window.__driveload_status.running = false;
  }
  function setDone() {
    window.__driveload_status.done    = true;
    window.__driveload_status.running = false;
    window.__driveload_status.progress = 100;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    // ── 2. Scroll through entire document so all pages render ────────────────
    setStatus("Scrolling to render all pages…", 2);
    const scrollEl = document.querySelector("[role='main']") ||
                     document.querySelector(".ndfHFb-c4YZDc") ||
                     document.documentElement;

    const totalH = () => Math.max(
      scrollEl.scrollHeight, document.body.scrollHeight,
      document.documentElement.scrollHeight
    );

    // First pass: scroll down slowly
    let pos = 0;
    const step = Math.max(window.innerHeight * 0.7, 400);
    while (pos < totalH()) {
      scrollEl.scrollTop = pos;
      window.scrollTo(0, pos);
      await sleep(400);
      pos += step;
    }
    // Scroll back to top
    scrollEl.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(800);

    // ── 3. Collect blob images (PDF pages rendered by Drive viewer) ───────────
    setStatus("Collecting pages…", 15);

    let imgs = Array.from(document.images)
      .filter(img => img.src.startsWith("blob:") && img.naturalWidth > 0 && img.naturalHeight > 0);

    if (imgs.length === 0) {
      // Try one more scroll pass and wait longer
      pos = 0;
      while (pos < totalH()) {
        scrollEl.scrollTop = pos;
        window.scrollTo(0, pos);
        await sleep(600);
        pos += step;
      }
      scrollEl.scrollTop = 0;
      window.scrollTo(0, 0);
      await sleep(1200);
      imgs = Array.from(document.images)
        .filter(img => img.src.startsWith("blob:") && img.naturalWidth > 0 && img.naturalHeight > 0);
    }

    if (imgs.length === 0) {
      setError("No PDF pages found. Make sure the PDF is fully open in the Drive viewer, then try again.");
      return;
    }

    // Sort by vertical page order
    imgs.sort((a, b) => {
      const rA = a.getBoundingClientRect(), rB = b.getBoundingClientRect();
      const topA = rA.top + window.scrollY + scrollEl.scrollTop;
      const topB = rB.top + window.scrollY + scrollEl.scrollTop;
      return topA - topB || rA.left - rB.left;
    });

    // Deduplicate by src
    const seen = new Set();
    imgs = imgs.filter(img => {
      if (seen.has(img.src)) return false;
      seen.add(img.src);
      return true;
    });

    setStatus(`Found ${imgs.length} pages — building PDF…`, 20);

    // ── 4. Build PDF with jsPDF ───────────────────────────────────────────────
    if (!window.jspdf) {
      setError("jsPDF not loaded. Please reload the extension.");
      return;
    }
    const { jsPDF } = window.jspdf;

    const firstImg = imgs[0];
    const isLS = w => w > 1 ? w : 0;  // helper
    const orientation = firstImg.naturalWidth > firstImg.naturalHeight ? "landscape" : "portrait";

    const pdf = new jsPDF({
      orientation,
      unit: "px",
      format: [firstImg.naturalWidth, firstImg.naturalHeight],
      hotfixes: ["px_scaling"],
    });

    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      setStatus(`Processing page ${i + 1} of ${imgs.length}…`, 20 + (i / imgs.length) * 70);

      if (i > 0) {
        const orient = img.naturalWidth > img.naturalHeight ? "landscape" : "portrait";
        pdf.addPage([img.naturalWidth, img.naturalHeight], orient);
      }

      // Draw to canvas to get image data
      const canvas = document.createElement("canvas");
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        ctx.drawImage(img, 0, 0);
      } catch (e) {
        // If canvas is tainted just skip; continue with other pages
        continue;
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 1.0);
      pdf.addImage(dataUrl, "JPEG", 0, 0, img.naturalWidth, img.naturalHeight, undefined, "FAST");
    }

    // ── 5. Save ───────────────────────────────────────────────────────────────
    setStatus("Saving PDF…", 95);
    const rawTitle = document.title
      .replace(/\s*-\s*Google\s*(Drive|Docs|Slides|Sheets).*$/i, "")
      .replace(/[\\/*?:"<>|]/g, "_")
      .trim() || "document";
    pdf.save(`${rawTitle}.pdf`);

    setDone();

  } catch (err) {
    setError("Error: " + err.message);
  }
})();
