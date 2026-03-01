/**
 * TikTok Bulk Repost Remover — v4
 *
 * KEY FIX: Session is stored by a random `sessionToken` (not socket.id)
 * Client sends the same token even after Socket.io reconnect
 * Server re-attaches the socket to the existing browser session
 */

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright");
const crypto     = require("crypto");
const path       = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 10e6,
  // Increase timeouts to prevent frequent disconnects on mobile
  pingTimeout:  120000,
  pingInterval: 30000,
  connectTimeout: 45000,
  allowEIO3: true
});

app.use(express.static(path.join(__dirname, "public")));

// ══════════════════════════════════════════════════════════════════
// SELECTORS
// ══════════════════════════════════════════════════════════════════
const SEL = {
  qrEl: [
    '[data-e2e="qrcode-image"]',
    'canvas[class*="qrcode" i]',
    'canvas[class*="QRCode"]',
    'img[class*="qrcode" i]',
    'div[class*="QRLogin"] canvas',
    'canvas',
  ],
  captcha: [
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    'img[src*="captcha"]',
  ],
  repostTab: [
    '[data-e2e="user-tab-repost"]',
    '[role="tab"]:has-text("Reposts")',
    'div[class*="TabItem"]:has-text("Reposts")',
    'span:has-text("Reposts")',
    'button:has-text("Reposts")',
  ],
  repostCard: [
    '[data-e2e="user-post-item"]',
    'div[class*="DivItemContainer"]',
    'div[class*="DivVideoFeed"] > div',
    'div[class*="video-feed-item"]',
  ],
  shareBtn: [
    '[data-e2e="share-icon"]',
    '[data-e2e="browse-share"]',
    '[data-e2e="video-share-icon"]',
    'button[class*="share" i]',
    '[aria-label*="Share" i]',
    'div[class*="share" i][role="button"]',
  ],
  removeRepostBtn: [
    '[data-e2e="remove-repost"]',
    '[data-e2e="remove-repost-option"]',
    'p:has-text("Remove repost")',
    'span:has-text("Remove repost")',
    'div:has-text("Remove repost")',
    'button:has-text("Remove repost")',
    '[role="menuitem"]:has-text("Remove repost")',
  ],
  confirmBtn: [
    '[data-e2e="confirm-remove"]',
    '[role="dialog"] button:last-child',
  ],
};

const STEALTH = `
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'plugins',{get:()=>{
    const a=[{name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'},
             {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
             {name:'Native Client',filename:'internal-nacl-plugin'}];
    a.__proto__=PluginArray.prototype; return a;
  }});
  Object.defineProperty(navigator,'platform',{get:()=>'Win32'});
  Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
  Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  const _gp=WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter=function(p){
    if(p===37445)return'Google Inc. (NVIDIA)';
    if(p===37446)return'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)';
    return _gp.call(this,p);
  };
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
`;

// ══════════════════════════════════════════════════════════════════
// SESSION STORE  — keyed by sessionToken, NOT socket.id
// ══════════════════════════════════════════════════════════════════
const sessions = new Map();
// token → { browser, page, active, socket (latest) }

function emit(token, event, data) {
  const s = sessions.get(token);
  if (s && s.socket) {
    try { s.socket.emit(event, data); } catch (_) {}
  }
}

async function cleanup(token) {
  const s = sessions.get(token);
  if (!s) return;
  s.active = false;
  try { await s.browser.close(); } catch (_) {}
  sessions.delete(token);
  console.log(`[cleanup] token:${token.slice(0,8)}`);
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
async function findEl(page, key, timeout = 6000) {
  for (const sel of SEL[key]) {
    try {
      const el = await page.waitForSelector(sel, { timeout, state: "visible" });
      if (el) return el;
    } catch (_) {}
  }
  return null;
}

async function hasCaptcha(page) {
  for (const sel of SEL.captcha) {
    try { if (await page.$(sel)) return true; } catch (_) {}
  }
  return false;
}

function rnd(min = 1200, max = 2500) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min)) + min));
}

// ══════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.on("connection", socket => {
  console.log(`[+] socket:${socket.id}`);

  // Client sends their token on every connect/reconnect
  socket.on("attach", token => {
    const s = sessions.get(token);
    if (s) {
      s.socket = socket; // re-attach new socket to existing session
      console.log(`[re-attach] token:${token.slice(0,8)} → socket:${socket.id}`);
      socket.emit("reattached", { ok: true });
    }
  });

  socket.on("stop", async () => {
    // Find session by socket
    for (const [token, s] of sessions) {
      if (s.socket && s.socket.id === socket.id) {
        await cleanup(token);
        socket.emit("status", { step: "stopped", msg: "Stopped." });
        return;
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`[-] socket:${socket.id}`);
    // Don't cleanup — session stays alive for re-attach
    // Sessions auto-cleanup after QR timeout or completion
  });

  socket.on("start", async () => {
    // Check if this socket already has a running session
    for (const [, s] of sessions) {
      if (s.socket && s.socket.id === socket.id) {
        socket.emit("error", "Already running.");
        return;
      }
    }

    const token = crypto.randomBytes(16).toString("hex");
    // Send token to client immediately so it can re-attach on reconnect
    socket.emit("session_token", token);

    let browser, qrInterval, qrTimeout;

    try {
      sessions.set(token, { browser: null, page: null, active: true, socket });

      emit(token, "status", { step: "launching", msg: "🚀 Starting browser..." });

      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars", "--disable-extensions",
          "--window-size=1280,800",
        ],
      });

      const ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
          "sec-ch-ua": '"Chromium";v="124","Google Chrome";v="124","Not-A.Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
      });

      const page = await ctx.newPage();
      await page.addInitScript(STEALTH);

      // Update session with browser + page
      sessions.set(token, { browser, page, active: true, socket });

      emit(token, "status", { step: "navigating", msg: "🌐 Opening TikTok QR login..." });
      await page.goto("https://www.tiktok.com/login/qrcode", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      if (!page.url().includes("qrcode")) {
        await page.goto("https://www.tiktok.com/login?loginType=qrCode", { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(2000);
      }

      emit(token, "status", { step: "qr_ready", msg: "📷 Scan the QR code with your TikTok app" });

      let loginDetected = false;
      let loginCheckStartTime = Date.now();
      let loginCheckTimeout = null;

      // 3-minute timeout for QR
      qrTimeout = setTimeout(async () => {
        if (!loginDetected) {
          clearInterval(qrInterval);
          if (loginCheckTimeout) clearTimeout(loginCheckTimeout);
          emit(token, "error", "QR expired after 3 minutes — try again.");
          await cleanup(token);
        }
      }, 3 * 60 * 1000);
      
      // Extra safety: if login not detected after 1.5 minutes, try to force-check
      loginCheckTimeout = setTimeout(async () => {
        if (!loginDetected && sessions.get(token)) {
          const sess = sessions.get(token);
          if (sess && sess.page) {
            const url = sess.page.url();
            const hasProfile = await sess.page.$('[data-e2e="nav-profile"]').catch(() => null);
            console.log(`[login-check-force] token:${token.slice(0,8)} url:${url} profile:${!!hasProfile}`);
            
            if ((!url.includes("/login") && !url.includes("qrcode")) || hasProfile) {
              loginDetected = true;
              clearInterval(qrInterval);
              clearTimeout(qrTimeout);
              emit(token, "status", { step: "logged_in", msg: "✅ Logged in! Finding profile..." });
              await startRemoving(token, sess.page);
            }
          }
        }
      }, 90 * 1000);

      // Stream screenshots every 2s
      qrInterval = setInterval(async () => {
        const sess = sessions.get(token);
        if (!sess || !sess.active) { clearInterval(qrInterval); return; }

        try {
          const url = page.url();

          // Login = left /login page
          // More reliable detection: check if NOT on login page AND page has loaded
          const isLoginPage = url.includes("/login") || url.includes("qrcode");
          
          // Enhanced detection: look for elements that only appear after login
          const loggedInSelectors = ['[data-e2e="nav-profile"]', '[data-e2e="nav-upload"]', 'a[href*="/@"]'];
          let hasLoggedInElement = false;
          for (const sel of loggedInSelectors) {
            if (await page.$(sel).catch(() => null)) {
              hasLoggedInElement = true;
              break;
            }
          }

          if ((!isLoginPage || hasLoggedInElement) && !loginDetected) {
            console.log(`[login-detected] token:${token.slice(0,8)} url:${url} element:${hasLoggedInElement}`);
            // Double-check: wait a bit and verify we're really logged in
            await page.waitForTimeout(1500);
            const newUrl = page.url();
            const stillNotLogin = !newUrl.includes("/login") && !newUrl.includes("qrcode");
            
            if (stillNotLogin || hasLoggedInElement) {
              loginDetected = true;
              clearInterval(qrInterval);
              clearTimeout(qrTimeout);
              if (loginCheckTimeout) clearTimeout(loginCheckTimeout);
              emit(token, "status", { step: "logged_in", msg: "✅ Logged in! Finding profile..." });
              await startRemoving(token, page);
              return;
            }
          }

          if (await hasCaptcha(page)) {
            emit(token, "captcha_detected", true);
            const shot = await page.screenshot({ type: "jpeg", quality: 70 });
            emit(token, "qr_frame", shot.toString("base64"));
            return;
          }

          try {
            const clip = await getQRRegion(page);
            const shot = await page.screenshot({ type: "jpeg", quality: 85, clip });
            emit(token, "qr_frame", shot.toString("base64"));
          } catch (screenshotErr) {
            // Fallback: take full screenshot if region fails
            try {
              const shot = await page.screenshot({ type: "jpeg", quality: 70 });
              emit(token, "qr_frame", shot.toString("base64"));
            } catch (_) {}
          }

        } catch (_) {}
      }, 2000);

    } catch (err) {
      if (qrInterval) clearInterval(qrInterval);
      if (qrTimeout)  clearTimeout(qrTimeout);
      if (loginCheckTimeout) clearTimeout(loginCheckTimeout);
      console.error("Launch error:", err.message);
      emit(token, "error", "Failed to start: " + err.message);
      await cleanup(token);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// QR REGION
// ══════════════════════════════════════════════════════════════════
async function getQRRegion(page) {
  try {
    const el = await page.$(SEL.qrEl.join(","));
    if (el) {
      const b = await el.boundingBox();
      if (b && b.width > 10) {
        const p = 50;
        return { x: Math.max(0,b.x-p), y: Math.max(0,b.y-p), width: Math.min(1280,b.width+p*2), height: Math.min(800,b.height+p*2) };
      }
    }
  } catch (_) {}
  return { x: 290, y: 120, width: 700, height: 560 };
}

// ══════════════════════════════════════════════════════════════════
// GET PROFILE URL
// ══════════════════════════════════════════════════════════════════
async function getProfileUrl(page) {
  try {
    const links = await page.$$('a[href*="/@"]');
    for (const l of links) {
      const href = await l.getAttribute("href");
      if (href) {
        const m = href.match(/\/@([^/?#]+)/);
        if (m && m[1] !== "tiktok") return `https://www.tiktok.com/@${m[1]}`;
      }
    }
  } catch (_) {}

  const m = page.url().match(/\/@([^/?#]+)/);
  if (m) return `https://www.tiktok.com/@${m[1]}`;

  try {
    await page.goto("https://www.tiktok.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2500);
    for (const sel of ['[data-e2e="nav-profile"]', 'header a[href*="/@"]']) {
      try {
        const el = await page.$(sel);
        if (el) {
          const href = await el.getAttribute("href");
          const mx = href && href.match(/\/@([^/?#]+)/);
          if (mx) return `https://www.tiktok.com/@${mx[1]}`;
        }
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

// ══════════════════════════════════════════════════════════════════
// REMOVAL FLOW: video page → Share → Remove Repost
// ══════════════════════════════════════════════════════════════════
async function startRemoving(token, page) {
  try {
    const sess = sessions.get(token);
    if (!sess || !sess.active) return;
    
    await page.waitForTimeout(2000);

    emit(token, "status", { step: "profile", msg: "👤 Finding your profile..." });
    const profileUrl = await getProfileUrl(page);
    if (!profileUrl) { 
      emit(token, "error", "Could not find your profile. Try again."); 
      await cleanup(token);
      return; 
    }

    emit(token, "status", { step: "profile", msg: `📂 Loading profile...` });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);

    if (await hasCaptcha(page)) {
      const shot = await page.screenshot({ type: "jpeg", quality: 70 });
      emit(token, "qr_frame", shot.toString("base64"));
      emit(token, "error", "TikTok security check on profile. Try again later.");
      await cleanup(token);
      return;
    }

    emit(token, "status", { step: "reposts_tab", msg: "🔄 Opening Reposts tab..." });
    const tab = await findEl(page, "repostTab", 12000);
    if (!tab) {
      emit(token, "status", { step: "done", msg: "✅ No Reposts tab — you have no reposts!" });
      emit(token, "complete", { removed: 0, failed: 0 });
      await cleanup(token);
      return;
    }
    await tab.click();
    await page.waitForTimeout(2500);

    emit(token, "status", { step: "collecting", msg: "📋 Scanning reposts..." });

    let removed = 0, failed = 0;
    const videoUrls = new Set();

    emit(token, "status", { step: "collecting", msg: "📋 Scanning reposts..." });

    let lastVideoCount = 0;
    let scrollCount = 0;
    while (scrollCount < 100) { // Limit scrolling to prevent infinite loops
      const sess = sessions.get(token);
      if (!sess || !sess.active) {
        console.log(`[collecting] Session inactive for token:${token.slice(0,8)}`);
        break;
      }

      if (await hasCaptcha(page)) {
        const shot = await page.screenshot({ type: "jpeg", quality: 70 });
        emit(token, "qr_frame", shot.toString("base64"));
        emit(token, "captcha_detected", true);
        emit(token, "error", "Security check appeared. Wait a few minutes then try again.");
        await cleanup(token);
        break;
      }

      const cards = await page.$$(SEL.repostCard.join(","));
      for (const card of cards) {
        try {
          const link = await card.$("a[href*=\"/video/\"]");
          if (link) {
            const videoUrl = await link.getAttribute("href");
            if (videoUrl) {
              videoUrls.add(videoUrl.startsWith("http") ? videoUrl : `https://www.tiktok.com${videoUrl}`);
            }
          }
        } catch (_) {}
      }

      emit(token, "collecting", { found: videoUrls.size });

      if (videoUrls.size === lastVideoCount) {
        // Scrolled to the end or no new videos loaded
        break;
      }
      lastVideoCount = videoUrls.size;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      scrollCount++;
    }

    emit(token, "status", { step: "removing", msg: `🗣️ Removing ${videoUrls.size} reposts...` });

    for (const fullUrl of videoUrls) {
      const sess = sessions.get(token);
      if (!sess || !sess.active) {
        console.log(`[removing] Session inactive for token:${token.slice(0,8)}`);
        break;
      }

      try {
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(1500);

        if (await hasCaptcha(page)) { 
          failed++; 
          try { await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
          await page.waitForTimeout(1000); 
          continue; 
        }

        const shareBtn = await findEl(page, "shareBtn", 5000);
        if (!shareBtn) { 
          failed++; 
          try { await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
          await page.waitForTimeout(1000); 
          continue; 
        }

        await shareBtn.click();
        await page.waitForTimeout(1200);

        const removeBtn = await findEl(page, "removeRepostBtn", 5000);
        if (!removeBtn) {
          try { await page.keyboard.press("Escape"); } catch (_) {}
          failed++;
          try { await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
          await page.waitForTimeout(1000);
          continue;
        }

        await removeBtn.click();
        await page.waitForTimeout(700);

        try {
          const conf = await page.$(SEL.confirmBtn.join(","));
          if (conf) { await conf.click(); await page.waitForTimeout(500); }
        } catch (_) {}

        removed++;

        emit(token, "progress", {
          current: removed,
          total: videoUrls.size,
          removed,
          failed,
        });

        await rnd(1200, 2500);

      } catch (e) {
        console.log("Video err:", e.message);
        failed++;
        try { await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
        await page.waitForTimeout(800);
      }
    }

    const msg = removed === 0
      ? "✅ No reposts found — you're all clean!"
      : `✅ Done! Removed ${removed} repost${removed !== 1 ? "s" : ""}` + (failed > 0 ? ` · ${failed} failed` : "");

    emit(token, "status", { step: "done", msg });
    emit(token, "complete", { removed, failed });
    await cleanup(token);

  } catch (err) {
    console.error("Removal error:", err.message);
    emit(token, "error", "Error: " + err.message);
    await cleanup(token);
  }
}

// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Running on port ${PORT}`));
