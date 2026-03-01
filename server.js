/**
 * TikTok Bulk Repost Remover — v7 FINAL
 *
 * ROOT CAUSE FIX (confirmed from logs):
 *   TikTok on datacenter IP does NOT redirect the browser after QR scan.
 *   Instead, it sets session cookies via the QR polling API response headers.
 *   Previous code only checked page.url() and ctx.cookies() — both miss this.
 *
 * SOLUTION — TRIPLE-LAYER login detection:
 *   Layer 1: page.on('response') — intercepts Set-Cookie headers on EVERY request
 *   Layer 2: setInterval 500ms — checks ctx.cookies('tiktok.com') and document.cookie
 *   Layer 3: DOM check — logged-in elements on page
 *
 * ALL 6 BUGS FIXED:
 *   ✅ BUG 1: Response-level cookie interception (not just context.cookies)
 *   ✅ BUG 2: networkidle → domcontentloaded in getProfileUrl
 *   ✅ BUG 3: ctx.cookies filtered to tiktok.com domain only
 *   ✅ BUG 4: document.cookie check from inside JS context
 *   ✅ BUG 5: 500ms cookie polling (was 2000ms — too slow)
 *   ✅ BUG 6: Scroll loop with no-new-content detection
 */

"use strict";

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
  pingTimeout:    120000,
  pingInterval:   30000,
  connectTimeout: 45000,
  allowEIO3: true,
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
    '[id*="captcha" i]',
    '[class*="CaptchaContainer"]',
    '[class*="captcha-container"]',
    'img[src*="/captcha/"]',
    '[class*="Secsdk"]',
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
    'div[class*="MenuItem"]:has-text("Remove repost")',
    'button:has-text("Remove repost")',
    '[role="menuitem"]:has-text("Remove repost")',
  ],
  confirmBtn: [
    '[data-e2e="confirm-remove"]',
    '[role="dialog"] button:has-text("Remove")',
    '[role="dialog"] button:last-child',
    '[class*="ConfirmModal"] button:last-child',
  ],
};

// ══════════════════════════════════════════════════════════════════
// STEALTH
// ══════════════════════════════════════════════════════════════════
const STEALTH = `
(function() {
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  Object.defineProperty(navigator,'plugins',{get:()=>{
    const a=[
      {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'},
      {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
      {name:'Native Client',filename:'internal-nacl-plugin'},
    ];
    a.__proto__=PluginArray.prototype; return a;
  }});
  Object.defineProperty(navigator,'platform',{get:()=>'Win32'});
  Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
  Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  const _gp=WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter=function(p){
    if(p===37445)return'Google Inc. (NVIDIA)';
    if(p===37446)return'ANGLE (NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    return _gp.call(this,p);
  };
  const _td=HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL=function(t){
    const c=this.getContext('2d');
    if(c){const d=c.getImageData(0,0,this.width||1,this.height||1);d.data[0]^=1;c.putImageData(d,0,0);}
    return _td.apply(this,arguments);
  };
  window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{},app:{}};
})();
`;

// ══════════════════════════════════════════════════════════════════
// SESSION STORE
// ══════════════════════════════════════════════════════════════════
const sessions = new Map();

function emit(token, event, data) {
  const s = sessions.get(token);
  if (s && s.socket && s.socket.connected) {
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
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return true;
    } catch (_) {}
  }
  return false;
}

// BUG 3 FIX: Check specifically tiktok.com cookies
async function hasTiktokSession(ctx) {
  try {
    const cookies = await ctx.cookies("https://www.tiktok.com");
    return cookies.some(c =>
      c.name === "sessionid" ||
      c.name === "sid_guard" ||
      c.name === "uid_tt" ||
      c.name === "sid_tt"
    );
  } catch (_) { return false; }
}

const rnd = (min = 1200, max = 2800) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min)) + min));

// ══════════════════════════════════════════════════════════════════
// SOCKET.IO
// ══════════════════════════════════════════════════════════════════
io.on("connection", socket => {
  console.log(`[+] socket:${socket.id}`);

  socket.on("attach", token => {
    const s = sessions.get(token);
    if (s) {
      s.socket = socket;
      console.log(`[re-attach] token:${token.slice(0,8)} → socket:${socket.id}`);
      socket.emit("reattached", { ok: true });
    }
  });

  socket.on("stop", async () => {
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
  });

  socket.on("start", async () => {
    for (const [, s] of sessions) {
      if (s.socket && s.socket.id === socket.id) {
        socket.emit("error", "Already running.");
        return;
      }
    }

    const token = crypto.randomBytes(16).toString("hex");
    socket.emit("session_token", token);

    let browser, qrInterval, cookieInterval, qrTimeout;

    try {
      sessions.set(token, { browser: null, page: null, ctx: null, active: true, socket });

      emit(token, "status", { step: "launching", msg: "🚀 Starting browser..." });

      browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars", "--disable-extensions",
          "--window-size=1280,800",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
        ],
      });

      const ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "America/New_York",
        extraHTTPHeaders: {
          "Accept-Language":    "en-US,en;q=0.9",
          "sec-ch-ua":          '"Chromium";v="124","Google Chrome";v="124","Not-A.Brand";v="99"',
          "sec-ch-ua-mobile":   "?0",
          "sec-ch-ua-platform": '"Windows"',
        },
      });

      const page = await ctx.newPage();
      await page.addInitScript(STEALTH);

      sessions.set(token, { browser, page, ctx, active: true, socket });

      // ╔══════════════════════════════════════════════════════════╗
      // ║  BUG 1 FIX — LAYER 1: Response interceptor              ║
      // ║  Fires on EVERY HTTP response from TikTok               ║
      // ║  Catches Set-Cookie headers even if page URL unchanged   ║
      // ╚══════════════════════════════════════════════════════════╝
      let loginDetected = false;

      async function onLoginDetected(source) {
        if (loginDetected) return;
        loginDetected = true;

        clearInterval(qrInterval);
        clearInterval(cookieInterval);
        clearTimeout(qrTimeout);

        console.log(`[LOGIN ✅] source:${source} — token:${token.slice(0,8)}`);
        emit(token, "status", { step: "logged_in", msg: "✅ تم تسجيل الدخول! جاري التحضير..." });

        // Force navigate out of login page
        for (const url of ["https://www.tiktok.com/foryou", "https://www.tiktok.com/"]) {
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
            break;
          } catch (_) {}
        }
        await page.waitForTimeout(2500);

        await startRemoving(token, page, ctx);
      }

      // Set up response interceptor BEFORE navigating
      page.on("response", async (response) => {
        if (loginDetected) return;
        try {
          const url = response.url();
          if (!url.includes("tiktok.com")) return;

          // Check Set-Cookie response headers
          const headers  = response.headers();
          const setCookie = headers["set-cookie"] || "";

          if (
            setCookie.includes("sessionid=") ||
            setCookie.includes("sid_guard=") ||
            setCookie.includes("uid_tt=") ||
            setCookie.includes("sid_tt=")
          ) {
            console.log(`[response-cookie] ${url.slice(0,70)} → ${setCookie.slice(0,50)}`);
            await onLoginDetected("response:Set-Cookie");
            return;
          }

          // Check QR API response body for "confirmed" status
          if (url.includes("qrcode") || url.includes("passport") || url.includes("login/app")) {
            try {
              const text = await response.text().catch(() => "");
              if (
                text.includes('"confirmed"') ||
                text.includes('"login_status":1') ||
                text.includes('"redirect_url"') ||
                (text.includes('"status"') && text.includes('1'))
              ) {
                console.log(`[response-body] QR confirmed in: ${url.slice(0,70)}`);
                // Wait briefly for cookies to be set
                await page.waitForTimeout(800);
                await onLoginDetected("response:body-confirmed");
              }
            } catch (_) {}
          }
        } catch (_) {}
      });

      emit(token, "status", { step: "navigating", msg: "🌐 Opening TikTok QR login..." });

      await page.goto("https://www.tiktok.com/login/qrcode", {
        waitUntil: "domcontentloaded", timeout: 30000,
      });
      await page.waitForTimeout(3000);

      if (!page.url().includes("qrcode") && page.url().includes("login")) {
        await page.goto("https://www.tiktok.com/login?loginType=qrCode", {
          waitUntil: "domcontentloaded", timeout: 20000,
        });
        await page.waitForTimeout(2000);
      }

      emit(token, "status", { step: "qr_ready", msg: "📷 صوّر الـ QR بتطبيق TikTok" });

      // 3-minute hard timeout
      qrTimeout = setTimeout(async () => {
        if (!loginDetected) {
          clearInterval(qrInterval);
          clearInterval(cookieInterval);
          emit(token, "error", "انتهى وقت الـ QR (3 دقائق) — حاول مرة تانية");
          await cleanup(token);
        }
      }, 3 * 60 * 1000);

      // ╔══════════════════════════════════════════════════════════╗
      // ║  BUG 5 FIX — LAYER 2: Fast 500ms cookie polling         ║
      // ║  Catches cookies set between response interceptor calls  ║
      // ╚══════════════════════════════════════════════════════════╝
      cookieInterval = setInterval(async () => {
        if (loginDetected) { clearInterval(cookieInterval); return; }
        const sess = sessions.get(token);
        if (!sess || !sess.active) { clearInterval(cookieInterval); return; }

        try {
          // BUG 4 FIX: Check document.cookie from inside the page
          const jsCookie = await page.evaluate(() => {
            const c = document.cookie || "";
            return (
              c.includes("sessionid=") ||
              c.includes("sid_guard=") ||
              c.includes("uid_tt=")
            );
          }).catch(() => false);

          if (jsCookie) {
            await onLoginDetected("document.cookie");
            return;
          }

          // BUG 3 FIX: Filtered tiktok.com cookie check
          if (await hasTiktokSession(ctx)) {
            await onLoginDetected("ctx.cookies(tiktok.com)");
            return;
          }

          // Standard URL check
          const url = page.url();
          if (!url.includes("/login") && !url.includes("qrcode") && url.includes("tiktok.com")) {
            await onLoginDetected("url-left-login");
            return;
          }

          // DOM element check
          const el = await page.$(
            '[data-e2e="nav-profile"], [data-e2e="nav-upload"], [data-e2e="home-page"]'
          ).catch(() => null);
          if (el) {
            await onLoginDetected("dom-logged-in-el");
          }
        } catch (_) {}
      }, 500);

      // Screenshot stream every 2s
      qrInterval = setInterval(async () => {
        if (loginDetected) { clearInterval(qrInterval); return; }
        const sess = sessions.get(token);
        if (!sess || !sess.active) { clearInterval(qrInterval); return; }

        try {
          if (await hasCaptcha(page)) {
            emit(token, "captcha_detected", true);
            const shot = await page.screenshot({ type: "jpeg", quality: 70 });
            emit(token, "qr_frame", shot.toString("base64"));
            return;
          }

          const clip = await getQRRegion(page);
          const shot = await page.screenshot({ type: "jpeg", quality: 85, clip });
          emit(token, "qr_frame", shot.toString("base64"));
        } catch (_) {}
      }, 2000);

    } catch (err) {
      if (qrInterval)    clearInterval(qrInterval);
      if (cookieInterval) clearInterval(cookieInterval);
      if (qrTimeout)     clearTimeout(qrTimeout);
      console.error("Launch error:", err.message);
      emit(token, "error", "Failed to start: " + err.message);
      await cleanup(token);
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
        const p = 50;
        return {
          x: Math.max(0, b.x-p), y: Math.max(0, b.y-p),
          width: Math.min(1280, b.width+p*2), height: Math.min(800, b.height+p*2),
        };
      }
    }
  } catch (_) {}
  return { x: 290, y: 120, width: 700, height: 560 };
}

// ══════════════════════════════════════════════════════════════════
// GET PROFILE URL
// ══════════════════════════════════════════════════════════════════
async function getProfileUrl(page, ctx) {
  // Method 1: Current URL
  let m = page.url().match(/\/@([^/?#\s]+)/);
  if (m && m[1] !== "tiktok") return `https://www.tiktok.com/@${m[1]}`;

  // Method 2: DOM links
  try {
    const links = await page.$$('a[href*="/@"]');
    for (const l of links) {
      const href = await l.getAttribute("href").catch(() => null);
      if (href) {
        const mx = href.match(/\/@([^/?#\s]+)/);
        if (mx && mx[1] !== "tiktok" && mx[1].length > 1) {
          return `https://www.tiktok.com/@${mx[1]}`;
        }
      }
    }
  } catch (_) {}

  // Method 3: Navigate home (BUG 2 FIX: domcontentloaded not networkidle)
  try {
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(3000);

    m = page.url().match(/\/@([^/?#\s]+)/);
    if (m && m[1] !== "tiktok") return `https://www.tiktok.com/@${m[1]}`;

    for (const sel of ['[data-e2e="nav-profile"]', 'header a[href*="/@"]', 'nav a[href*="/@"]']) {
      try {
        const el = await page.$(sel);
        if (el) {
          const href = await el.getAttribute("href").catch(() => null);
          if (href) {
            const mx = href.match(/\/@([^/?#\s]+)/);
            if (mx) return `https://www.tiktok.com/@${mx[1]}`;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Method 4: @me redirect
  try {
    await page.goto("https://www.tiktok.com/@me", {
      waitUntil: "domcontentloaded", timeout: 10000,
    });
    await page.waitForTimeout(2000);
    m = page.url().match(/\/@([^/?#\s]+)/);
    if (m && m[1] !== "me" && m[1] !== "tiktok") {
      return `https://www.tiktok.com/@${m[1]}`;
    }
  } catch (_) {}

  return null;
}

// ══════════════════════════════════════════════════════════════════
// NAVIGATE BACK TO REPOSTS TAB
// ══════════════════════════════════════════════════════════════════
async function backToReposts(page, profileUrl) {
  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    const tab = await findEl(page, "repostTab", 8000);
    if (tab) { await tab.click(); await page.waitForTimeout(1500); }
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════
// MAIN REMOVAL FLOW
// ══════════════════════════════════════════════════════════════════
async function startRemoving(token, page, ctx) {
  try {
    const sess = sessions.get(token);
    if (!sess || !sess.active) return;

    await page.waitForTimeout(2000);

    emit(token, "status", { step: "profile", msg: "👤 جاري البحث عن الـ profile..." });
    const profileUrl = await getProfileUrl(page, ctx);

    if (!profileUrl) {
      emit(token, "error", "مش قادر أحدد الـ profile URL. حاول مرة تانية.");
      await cleanup(token);
      return;
    }

    console.log(`[profile] ${profileUrl} — token:${token.slice(0,8)}`);
    emit(token, "status", { step: "profile", msg: "📂 بيحمل الـ profile..." });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(3000);

    if (await hasCaptcha(page)) {
      const shot = await page.screenshot({ type: "jpeg", quality: 70 });
      emit(token, "qr_frame", shot.toString("base64"));
      emit(token, "captcha_detected", true);
      emit(token, "error", "TikTok بيطلب تحقق أمني. حاول بعد دقيقتين.");
      await cleanup(token);
      return;
    }

    emit(token, "status", { step: "reposts_tab", msg: "🔄 بيدور على تاب الـ Reposts..." });
    const tab = await findEl(page, "repostTab", 12000);

    if (!tab) {
      emit(token, "status", { step: "done", msg: "✅ مفيش تاب Reposts — مفيش ريبوستات!" });
      emit(token, "complete", { removed: 0, failed: 0 });
      await cleanup(token);
      return;
    }

    await tab.click();
    await page.waitForTimeout(2500);

    // ── BUG 6 FIX: Collect with no-new detection ───────────────
    emit(token, "status", { step: "collecting", msg: "📋 بيجمع الريبوستات..." });

    const videoUrls = new Set();
    let noNewStreak = 0;

    for (let scroll = 0; scroll < 100; scroll++) {
      const sess2 = sessions.get(token);
      if (!sess2 || !sess2.active) break;

      if (await hasCaptcha(page)) {
        emit(token, "captcha_detected", true);
        break;
      }

      const prevSize = videoUrls.size;
      const cards = await page.$$(SEL.repostCard.join(","));

      for (const card of cards) {
        try {
          const link = await card.$('a[href*="/video/"]');
          if (link) {
            const href = await link.getAttribute("href").catch(() => null);
            if (href) {
              const full = href.startsWith("http") ? href : `https://www.tiktok.com${href}`;
              videoUrls.add(full);
            }
          }
        } catch (_) {}
      }

      emit(token, "collecting", { found: videoUrls.size });

      if (videoUrls.size === prevSize) {
        noNewStreak++;
        if (noNewStreak >= 3) break; // 3 scrolls with no new content = done
      } else {
        noNewStreak = 0;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    if (videoUrls.size === 0) {
      emit(token, "status", { step: "done", msg: "✅ مفيش ريبوستات — الـ profile نضيف!" });
      emit(token, "complete", { removed: 0, failed: 0 });
      await cleanup(token);
      return;
    }

    emit(token, "status", { step: "removing", msg: `🗑️ بيحذف ${videoUrls.size} ريبوست...` });
    emit(token, "total", videoUrls.size);

    let removed = 0, failed = 0;

    for (const fullUrl of videoUrls) {
      const sess3 = sessions.get(token);
      if (!sess3 || !sess3.active) break;

      try {
        await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(1500);

        if (await hasCaptcha(page)) {
          failed++;
          await backToReposts(page, profileUrl);
          continue;
        }

        const shareBtn = await findEl(page, "shareBtn", 6000);
        if (!shareBtn) {
          failed++;
          await backToReposts(page, profileUrl);
          continue;
        }

        await shareBtn.click();
        await page.waitForTimeout(1200);

        const removeBtn = await findEl(page, "removeRepostBtn", 5000);
        if (!removeBtn) {
          await page.keyboard.press("Escape").catch(() => {});
          failed++;
          await backToReposts(page, profileUrl);
          continue;
        }

        await removeBtn.click();
        await page.waitForTimeout(800);

        try {
          const conf = await page.$(SEL.confirmBtn.join(","));
          if (conf && await conf.isVisible()) {
            await conf.click();
            await page.waitForTimeout(600);
          }
        } catch (_) {}

        removed++;
        console.log(`[removed] ${removed}/${videoUrls.size} token:${token.slice(0,8)}`);

        emit(token, "progress", {
          current: removed,
          total: videoUrls.size,
          removed,
          failed,
        });

      } catch (e) {
        console.log(`[video-err] ${e.message.slice(0, 80)}`);
        failed++;
      }

      await backToReposts(page, profileUrl);
      await rnd(1200, 2500);
    }

    const msg = removed === 0
      ? "⚠️ مش قادر يحذف — ممكن TikTok بيمنع Remove Repost على الـ server IP"
      : `✅ خلصنا! حُذف ${removed} ريبوست` + (failed > 0 ? ` · فشل ${failed}` : "");

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
