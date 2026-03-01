const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 5e6, // 5MB for screenshots
});

app.use(express.static(path.join(__dirname, "public")));

// ── Selector Recovery System ──────────────────────────────────────────────────
// Each key has an array of selectors to try in order (TikTok changes classes)
const SELECTORS = {
  qrLoginBtn: [
    '[data-e2e="qrcode-login-button"]',
    'div[class*="QRCode"]',
    'button:has-text("Use QR code")',
    '[class*="qr-code"]',
    '[class*="qrCode"]',
    'div[class*="login-mode"]:has([class*="qr"])',
  ],
  qrCodeImg: [
    'canvas[class*="qrcode"]',
    'canvas[class*="QRCode"]',
    'img[class*="qrcode"]',
    '[data-e2e="qrcode-image"]',
    'canvas',
    '[class*="qr"] canvas',
    '[class*="qr"] img',
  ],
  profileAvatar: [
    '[data-e2e="avatar"]',
    '[class*="DivAvatar"]',
    '[class*="user-avatar"]',
    'img[class*="avatar"]',
    'a[href*="/@"]',
  ],
  repostTab: [
    '[data-e2e="user-tab-repost"]',
    'div[class*="TabItem"]:has-text("Reposts")',
    '[role="tab"]:has-text("Reposts")',
    'button:has-text("Reposts")',
    '[class*="tab"]:has-text("Repost")',
  ],
  repostItems: [
    '[data-e2e="user-post-item"]',
    '[class*="DivItemContainer"]',
    '[class*="VideoFeed"] [class*="Item"]',
    'div[class*="video-feed-item"]',
    'div[class*="repost-item"]',
  ],
  repostMenuBtn: [
    '[data-e2e="video-ellipsis"]',
    'button[class*="more"]',
    '[class*="more-btn"]',
    '[aria-label="More options"]',
    'div[class*="MoreBtn"]',
    'svg[class*="more"]',
  ],
  removeRepostOption: [
    '[data-e2e="remove-repost-option"]',
    'div[class*="MenuItem"]:has-text("Remove repost")',
    '[role="menuitem"]:has-text("Remove")',
    'button:has-text("Remove repost")',
    'li:has-text("Remove repost")',
    '[class*="menu-item"]:has-text("Remove")',
  ],
  confirmBtn: [
    '[data-e2e="confirm-remove"]',
    'button:has-text("Remove")',
    'button:has-text("Confirm")',
    '[class*="ConfirmBtn"]',
    '[role="button"]:has-text("Remove")',
  ],
};

async function findElement(page, selectorKey, timeout = 5000) {
  const candidates = SELECTORS[selectorKey];
  for (const sel of candidates) {
    try {
      const el = await page.waitForSelector(sel, {
        timeout,
        state: "visible",
      });
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

// ── Active Sessions ────────────────────────────────────────────────────────────
const sessions = new Map(); // socketId → { browser, page, status }

function randomDelay(min = 2000, max = 4000) {
  return new Promise((r) =>
    setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min)
  );
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  socket.on("start", async () => {
    if (sessions.has(socket.id)) {
      socket.emit("error", "Session already running");
      return;
    }

    let browser, page;
    let qrInterval;

    try {
      socket.emit("status", { step: "launching", msg: "🚀 Starting browser..." });

      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        viewport: { width: 390, height: 844 },
        locale: "en-US",
      });

      page = await context.newPage();
      sessions.set(socket.id, { browser, page, active: true });

      // ── STEP 1: Open TikTok login ──────────────────────────────────────────
      socket.emit("status", { step: "navigating", msg: "📱 Opening TikTok login..." });
      await page.goto("https://www.tiktok.com/login", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      // ── STEP 2: Click QR Code Login ────────────────────────────────────────
      socket.emit("status", { step: "qr_finding", msg: "🔍 Looking for QR login..." });

      const qrBtn = await findElement(page, "qrLoginBtn", 8000);
      if (qrBtn) {
        await qrBtn.click();
        await page.waitForTimeout(2000);
      }

      // ── STEP 3: Stream QR Code screenshots ────────────────────────────────
      socket.emit("status", { step: "qr_ready", msg: "📷 QR Code ready! Scan with TikTok app." });

      let loginDetected = false;

      qrInterval = setInterval(async () => {
        const session = sessions.get(socket.id);
        if (!session || !session.active) {
          clearInterval(qrInterval);
          return;
        }

        try {
          // Check if already logged in
          const avatarEl = await page.$(SELECTORS.profileAvatar.join(","));
          const url = page.url();
          if (avatarEl || url.includes("foryou") || url.includes("following")) {
            if (!loginDetected) {
              loginDetected = true;
              clearInterval(qrInterval);
              socket.emit("status", { step: "logged_in", msg: "✅ Logged in! Finding reposts..." });
              await startRemoving(socket, page);
            }
            return;
          }

          // Take screenshot and send
          const screenshot = await page.screenshot({
            type: "jpeg",
            quality: 75,
            clip: await getQRRegion(page),
          });
          socket.emit("qr_frame", screenshot.toString("base64"));
        } catch (e) {
          // Page might be navigating
        }
      }, 2000);

    } catch (err) {
      clearInterval(qrInterval);
      console.error("Session error:", err.message);
      socket.emit("error", "Something went wrong: " + err.message);
      await cleanup(socket.id);
    }
  });

  socket.on("disconnect", async () => {
    console.log(`[-] Client disconnected: ${socket.id}`);
    await cleanup(socket.id);
  });

  socket.on("stop", async () => {
    await cleanup(socket.id);
    socket.emit("status", { step: "stopped", msg: "⏹️ Stopped." });
  });
});

// ── Get QR Code region on page ─────────────────────────────────────────────
async function getQRRegion(page) {
  try {
    const qrEl = await page.$(SELECTORS.qrCodeImg.join(","));
    if (qrEl) {
      const box = await qrEl.boundingBox();
      if (box) {
        const padding = 30;
        return {
          x: Math.max(0, box.x - padding),
          y: Math.max(0, box.y - padding),
          width: box.width + padding * 2,
          height: box.height + padding * 2,
        };
      }
    }
  } catch (_) {}
  // fallback: full page
  return undefined;
}

// ── Main removal logic ─────────────────────────────────────────────────────
async function startRemoving(socket, page) {
  try {
    // Navigate to profile
    socket.emit("status", { step: "profile", msg: "👤 Going to your profile..." });
    await page.goto("https://www.tiktok.com/profile", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(3000);

    // Click Reposts tab
    socket.emit("status", { step: "reposts_tab", msg: "🔄 Opening Reposts tab..." });
    const repostTab = await findElement(page, "repostTab", 10000);
    if (!repostTab) {
      socket.emit("error", "Could not find Reposts tab. TikTok may have changed their layout.");
      return;
    }
    await repostTab.click();
    await page.waitForTimeout(2000);

    // Collect all reposts by scrolling
    socket.emit("status", { step: "collecting", msg: "📋 Collecting all your reposts..." });
    const repostUrls = await collectAllReposts(socket, page);

    if (repostUrls.length === 0) {
      socket.emit("status", { step: "done", msg: "✅ No reposts found - you're all clear!" });
      socket.emit("complete", { removed: 0, failed: 0 });
      return;
    }

    socket.emit("status", {
      step: "removing",
      msg: `🗑️ Found ${repostUrls.length} reposts. Starting removal...`,
    });
    socket.emit("total", repostUrls.length);

    let removed = 0;
    let failed = 0;

    // Remove each repost
    for (let i = 0; i < repostUrls.length; i++) {
      const session = sessions.get(socket.id);
      if (!session || !session.active) break;

      try {
        await removeRepost(page, repostUrls[i]);
        removed++;
      } catch (e) {
        failed++;
        console.log(`Failed to remove repost ${i + 1}:`, e.message);
      }

      socket.emit("progress", { current: i + 1, total: repostUrls.length, removed, failed });

      // Random delay between 2-4 seconds (anti-detection)
      if (i < repostUrls.length - 1) {
        await randomDelay(2000, 4000);
      }
    }

    socket.emit("status", {
      step: "done",
      msg: `✅ Done! Removed ${removed} reposts${failed > 0 ? `, ${failed} failed` : ""}.`,
    });
    socket.emit("complete", { removed, failed });

  } catch (err) {
    console.error("Removing error:", err.message);
    socket.emit("error", "Error during removal: " + err.message);
  }
}

// ── Scroll and collect all repost item URLs ────────────────────────────────
async function collectAllReposts(socket, page) {
  const urls = new Set();
  let lastCount = 0;
  let noChangeCount = 0;

  while (noChangeCount < 3) {
    // Find repost items
    const items = await page.$$(SELECTORS.repostItems.join(","));
    for (const item of items) {
      try {
        const link = await item.$("a[href*='/video/']");
        if (link) {
          const href = await link.getAttribute("href");
          if (href) urls.add(href);
        }
      } catch (_) {}
    }

    if (urls.size === lastCount) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
      lastCount = urls.size;
      socket.emit("collecting", { found: urls.size });
    }

    // Scroll down to load more
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(1500);
  }

  return Array.from(urls);
}

// ── Remove a single repost ─────────────────────────────────────────────────
async function removeRepost(page, videoUrl) {
  // Go to the video page
  const fullUrl = videoUrl.startsWith("http")
    ? videoUrl
    : `https://www.tiktok.com${videoUrl}`;
  await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForTimeout(1500);

  // Click more options (...)
  const menuBtn = await findElement(page, "repostMenuBtn", 5000);
  if (!menuBtn) throw new Error("Menu button not found");
  await menuBtn.click();
  await page.waitForTimeout(800);

  // Click "Remove repost"
  const removeOption = await findElement(page, "removeRepostOption", 5000);
  if (!removeOption) throw new Error("Remove repost option not found");
  await removeOption.click();
  await page.waitForTimeout(800);

  // Confirm if dialog appears
  const confirmBtn = await page.$(SELECTORS.confirmBtn.join(","));
  if (confirmBtn) {
    await confirmBtn.click();
    await page.waitForTimeout(500);
  }
}

// ── Cleanup session ────────────────────────────────────────────────────────
async function cleanup(socketId) {
  const session = sessions.get(socketId);
  if (session) {
    session.active = false;
    try {
      await session.browser.close();
    } catch (_) {}
    sessions.delete(socketId);
  }
}

// ── Start server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ TikTok Repost Remover running on port ${PORT}`);
});
