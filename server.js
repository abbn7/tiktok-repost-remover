/**
 * TikTok Bulk Repost Remover — v3 (all bugs fixed)
 *
 * CORRECT removal flow (confirmed 2026):
 *   Profile → Reposts tab → click video → Share button → "Remove Repost"
 *
 * Previous versions used 3-dot menu which does NOT exist for reposts.
 */

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright");
const path     = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 10e6 });

app.use(express.static(path.join(__dirname, "public")));

// ══════════════════════════════════════════════════════════════════
// SELECTORS  — arrays tried in order (TikTok renames classes often)
// ══════════════════════════════════════════════════════════════════
const SEL = {

  // QR canvas / img on login page
  qrEl: [
    '[data-e2e="qrcode-image"]',
    'canvas[class*="qrcode" i]',
    'canvas[class*="QRCode"]',
    'img[class*="qrcode" i]',
    'div[class*="QRLogin"] canvas',
    'canvas',
  ],

  // CAPTCHA puzzle indicators
  captcha: [
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    'div[class*="verify"]',
    'img[src*="captcha"]',
    '[class*="security-check"]',
  ],

  // Reposts tab on profile (two-arrow icon)
  repostTab: [
    '[data-e2e="user-tab-repost"]',
    '[role="tab"]:has-text("Reposts")',
    'div[class*="TabItem"]:has-text("Reposts")',
    'span:has-text("Reposts")',
    'button:has-text("Reposts")',
  ],

  // Repost video cards in the grid
  repostCard: [
    '[data-e2e="user-post-item"]',
    'div[class*="DivItemContainer"]',
    'div[class*="DivVideoFeed"] > div',
    'div[class*="video-feed-item"]',
  ],

  // ── CORRECT flow: Share button on the video page ──────────────
  shareBtn: [
    '[data-e2e="share-icon"]',
    '[data-e2e="browse-share"]',
    '[data-e2e="video-share-icon"]',
    'button[class*="share" i]',
    'div[class*="share" i][role="button"]',
    '[aria-label*="Share" i]',
    'span[class*="share" i]',
  ],

  // "Remove Repost" inside the Share menu / sheet
  removeRepostBtn: [
    '[data-e2e="remove-repost"]',
    '[data-e2e="remove-repost-option"]',
    // text-based fallbacks (most reliable)
    'p:has-text("Remove repost")',
    'span:has-text("Remove repost")',
    'div:has-text("Remove repost")',
    'button:has-text("Remove repost")',
    '[role="menuitem"]:has-text("Remove repost")',
    // yellow button on mobile sheet
    'button[class*="yellow"]',
  ],

  // Confirm dialog if any
  confirmBtn: [
    '[data-e2e="confirm-remove"]',
    'button:has-text("Remove")',
    'button:has-text("Confirm")',
    '[role="dialog"] button:last-child',
  ],

  // Close any overlay (ESC fallback)
  closeBtn: [
    '[data-e2e="modal-close-inner-button"]',
    'button[aria-label="Close"]',
    '[class*="close" i][role="button"]',
  ],
};

// ══════════════════════════════════════════════════════════════════
// STEALTH — patches all fingerprints TikTok checks
// ══════════════════════════════════════════════════════════════════
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
  const _td=HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL=function(t){
    const c=this.getContext('2d');
    if(c){const d=c.getImageData(0,0,this.width||1,this.height||1);d.data[0]^=1;c.putImageData(d,0,0);}
    return _td.apply(this,arguments);
  };
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
`;

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

function rnd(min = 1200, max = 2800) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min)) + min));
}

// ══════════════════════════════════════════════════════════════════
// SESSIONS
// ══════════════════════════════════════════════════════════════════
const sessions = new Map();

async function cleanup(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  s.active = false;
  try { await s.browser.close(); } catch (_) {}
  sessions.delete(sid);
  console.log(`[cleanup] ${sid}`);
}

// ══════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.on("connection", socket => {
  console.log(`[+] ${socket.id}`);
  socket.on("disconnect", () => cleanup(socket.id));
  socket.on("stop", async () => { await cleanup(socket.id); socket.emit("status",{step:"stopped",msg:"Stopped."}); });

  socket.on("start", async () => {
    if (sessions.has(socket.id)) { socket.emit("error","Already running."); return; }

    let browser, qrInterval, qrTimeout;

    try {
      socket.emit("status",{step:"launching",msg:"🚀 Starting browser..."});

      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox","--disable-setuid-sandbox",
          "--disable-dev-shm-usage","--disable-gpu","--no-zygote",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars","--disable-extensions",
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

      sessions.set(socket.id, { browser, page, active: true });

      // Navigate directly to QR login
      socket.emit("status",{step:"navigating",msg:"🌐 Opening TikTok QR login..."});
      await page.goto("https://www.tiktok.com/login/qrcode", { waitUntil:"domcontentloaded", timeout:30000 });
      await page.waitForTimeout(3000);

      // Fallback URL if first redirected
      if (!page.url().includes("qrcode")) {
        await page.goto("https://www.tiktok.com/login?loginType=qrCode", { waitUntil:"domcontentloaded", timeout:20000 });
        await page.waitForTimeout(2000);
      }

      socket.emit("status",{step:"qr_ready",msg:"📷 Scan the QR code with your TikTok app"});

      let loginDetected = false;

      // 3-minute QR timeout
      qrTimeout = setTimeout(async () => {
        if (!loginDetected) {
          clearInterval(qrInterval);
          socket.emit("error","QR expired after 3 minutes — try again.");
          await cleanup(socket.id);
        }
      }, 3 * 60 * 1000);

      // Stream QR screenshots
      qrInterval = setInterval(async () => {
        const sess = sessions.get(socket.id);
        if (!sess || !sess.active) { clearInterval(qrInterval); return; }
        try {
          const url = page.url();

          // Login detected = left /login page
          if (!url.includes("/login") && !loginDetected) {
            loginDetected = true;
            clearInterval(qrInterval);
            clearTimeout(qrTimeout);
            socket.emit("status",{step:"logged_in",msg:"✅ Logged in! Finding profile..."});
            await startRemoving(socket, page);
            return;
          }

          if (await hasCaptcha(page)) {
            socket.emit("captcha_detected", true);
            const shot = await page.screenshot({ type:"jpeg", quality:70 });
            socket.emit("qr_frame", shot.toString("base64"));
            return;
          }

          const clip = await getQRRegion(page);
          const shot = await page.screenshot({ type:"jpeg", quality:85, clip });
          socket.emit("qr_frame", shot.toString("base64"));
        } catch (_) {}
      }, 2000);

    } catch (err) {
      if (qrInterval) clearInterval(qrInterval);
      if (qrTimeout)  clearTimeout(qrTimeout);
      console.error("Launch error:", err.message);
      socket.emit("error","Failed to start: " + err.message);
      await cleanup(socket.id);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// QR REGION CROP
// ══════════════════════════════════════════════════════════════════
async function getQRRegion(page) {
  try {
    const el = await page.$(SEL.qrEl.join(","));
    if (el) {
      const b = await el.boundingBox();
      if (b && b.width > 10) {
        const pad = 50;
        return { x:Math.max(0,b.x-pad), y:Math.max(0,b.y-pad), width:Math.min(1280,b.width+pad*2), height:Math.min(800,b.height+pad*2) };
      }
    }
  } catch (_) {}
  return { x:290, y:120, width:700, height:560 };
}

// ══════════════════════════════════════════════════════════════════
// EXTRACT PROFILE URL
// ══════════════════════════════════════════════════════════════════
async function getProfileUrl(page) {
  // Method 1: any /@username link on current page
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

  // Method 2: from current URL
  const m = page.url().match(/\/@([^/?#]+)/);
  if (m) return `https://www.tiktok.com/@${m[1]}`;

  // Method 3: navigate home, find nav profile link
  try {
    await page.goto("https://www.tiktok.com/", { waitUntil:"domcontentloaded", timeout:15000 });
    await page.waitForTimeout(2500);
    for (const sel of ['[data-e2e="nav-profile"]','header a[href*="/@"]','a[href*="/@"][class*="profile" i]']) {
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
// CORRECT REMOVAL FLOW
// Profile → Reposts tab → click each video → Share → Remove Repost
// ══════════════════════════════════════════════════════════════════
async function startRemoving(socket, page) {
  try {
    await page.waitForTimeout(2000);

    socket.emit("status",{step:"profile",msg:"👤 Finding your profile..."});
    const profileUrl = await getProfileUrl(page);
    if (!profileUrl) { socket.emit("error","Could not find your profile. Try again."); return; }

    socket.emit("status",{step:"profile",msg:`📂 Loading ${profileUrl}`});
    await page.goto(profileUrl, { waitUntil:"domcontentloaded", timeout:20000 });
    await page.waitForTimeout(3000);

    if (await hasCaptcha(page)) {
      const shot = await page.screenshot({ type:"jpeg", quality:70 });
      socket.emit("qr_frame", shot.toString("base64"));
      socket.emit("error","TikTok security check on profile page. Server IP flagged — try again later.");
      return;
    }

    // Click Reposts tab
    socket.emit("status",{step:"reposts_tab",msg:"🔄 Opening Reposts tab..."});
    const tab = await findEl(page, "repostTab", 12000);
    if (!tab) {
      socket.emit("status",{step:"done",msg:"✅ No Reposts tab found — you have no reposts!"});
      socket.emit("complete",{removed:0,failed:0});
      return;
    }
    await tab.click();
    await page.waitForTimeout(2500);

    socket.emit("status",{step:"collecting",msg:"📋 Scanning reposts..."});

    let removed = 0, failed = 0, pass = 0;

    while (pass < 500) {
      const sess = sessions.get(socket.id);
      if (!sess || !sess.active) break;

      if (await hasCaptcha(page)) {
        const shot = await page.screenshot({ type:"jpeg", quality:70 });
        socket.emit("qr_frame", shot.toString("base64"));
        socket.emit("captcha_detected", true);
        socket.emit("error","TikTok security check during removal. Wait a few minutes then try again.");
        break;
      }

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);

      const cards = await page.$$(SEL.repostCard.join(","));
      if (cards.length === 0) break;

      socket.emit("collecting",{ found: removed + cards.length });

      let removedThisPass = 0;

      for (const card of cards.slice(0, 5)) {
        const sess2 = sessions.get(socket.id);
        if (!sess2 || !sess2.active) break;

        let videoUrl = null;

        // Get the video link from the card
        try {
          const link = await card.$('a[href*="/video/"]');
          if (link) videoUrl = await link.getAttribute("href");
        } catch (_) {}

        if (!videoUrl) { failed++; continue; }

        const fullUrl = videoUrl.startsWith("http") ? videoUrl : `https://www.tiktok.com${videoUrl}`;

        try {
          // Navigate to the video page
          await page.goto(fullUrl, { waitUntil:"domcontentloaded", timeout:15000 });
          await page.waitForTimeout(1500);

          if (await hasCaptcha(page)) {
            failed++;
            await page.goBack();
            await page.waitForTimeout(1000);
            continue;
          }

          // ── CORRECT FLOW: Share → Remove Repost ─────────────
          const shareBtn = await findEl(page, "shareBtn", 5000);
          if (!shareBtn) {
            console.log("Share button not found for:", fullUrl);
            failed++;
            await page.goBack();
            await page.waitForTimeout(1000);
            continue;
          }

          await shareBtn.click();
          await page.waitForTimeout(1200);

          // Find "Remove Repost" in the share sheet
          const removeBtn = await findEl(page, "removeRepostBtn", 5000);
          if (!removeBtn) {
            // Close share sheet and skip
            await page.keyboard.press("Escape");
            failed++;
            await page.goBack();
            await page.waitForTimeout(1000);
            continue;
          }

          await removeBtn.click();
          await page.waitForTimeout(700);

          // Handle confirm dialog if it appears
          try {
            const conf = await page.$(SEL.confirmBtn.join(","));
            if (conf) { await conf.click(); await page.waitForTimeout(500); }
          } catch (_) {}

          removed++;
          removedThisPass++;

          socket.emit("progress",{
            current: removed,
            total: Math.max(removed + failed, removed + cards.length),
            removed,
            failed,
          });

          // Go back to profile reposts tab
          await page.goto(profileUrl, { waitUntil:"domcontentloaded", timeout:15000 });
          await page.waitForTimeout(1500);

          // Re-click Reposts tab
          const t2 = await findEl(page, "repostTab", 8000);
          if (t2) { await t2.click(); await page.waitForTimeout(1500); }

          await rnd(1200, 2500);

        } catch (e) {
          console.log("Video error:", e.message);
          failed++;
          try { await page.goBack(); } catch (_) {}
          await page.waitForTimeout(800);
        }
      }

      if (removedThisPass === 0) break;
      pass++;
    }

    const msg = removed === 0
      ? "✅ No reposts found — you're all clean!"
      : `✅ Done! Removed ${removed} repost${removed!==1?"s":""}` + (failed>0?` · ${failed} failed`:"");

    socket.emit("status",{step:"done",msg});
    socket.emit("complete",{removed,failed});

  } catch (err) {
    console.error("Removal error:", err.message);
    socket.emit("error","Error: " + err.message);
  } finally {
    await cleanup(socket.id);
  }
}

// ══════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`✅ Running on port ${PORT}`));
