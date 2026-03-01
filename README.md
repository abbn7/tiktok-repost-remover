# TikTok Bulk Repost Remover

> Web app يشتغل على iPhone Safari — بيحذف كل ريبوستاتك دفعة واحدة عبر QR login

---

## 🚀 نشر على Railway (الطريقة الوحيدة المطلوبة)

### الخطوات (5 دقائق):

1. **ارفع المشروع على GitHub**
   - افتح [github.com/new](https://github.com/new)
   - سمّيه `tiktok-repost-remover`
   - ارفع كل الملفات

2. **افتح Railway**
   - روح [railway.app](https://railway.app) وسجّل دخول بـ GitHub
   - اضغط **"New Project"**
   - اختار **"Deploy from GitHub repo"**
   - اختار repo المشروع

3. **بس خلاص! 🎉**
   - Railway هيلاقي الـ Dockerfile تلقائياً
   - بعد الـ Build (3-5 دقايق) هيديك رابط مثل:
   - `https://tiktok-repost-remover-production.up.railway.app`

---

## 📁 ملفات المشروع

```
tiktok-repost-remover/
├── Dockerfile          ← بيستخدم Playwright Image الرسمي
├── railway.json        ← إعدادات Railway
├── package.json        ← Dependencies
├── server.js           ← Backend (Express + Socket.io + Playwright)
├── public/
│   └── index.html      ← Frontend (شغّال على iPhone Safari)
└── .gitignore
```

---

## ⚙️ كيف بيشتغل

```
المستخدم يفتح الموقع
       ↓
Backend يفتح Playwright browser (headless)
       ↓
يفتح tiktok.com/login بـ QR Mode
       ↓
يبعت screenshots للـ QR كل 2 ثانية عبر Socket.io
       ↓
المستخدم يصوّر QR من TikTok app
       ↓
Playwright يكشف Login ويروح Reposts Tab
       ↓
يجمع كل الريبوستات ويحذفها واحد واحد
(delay عشوائي 2-4 ثانية بين كل حذف)
       ↓
✅ "تم حذف 847 ريبوست"
```

---

## 💰 التكلفة

- **Railway Free Plan**: $5 credit/شهر — كافي للتجربة
- **Playwright + Chromium**: ~300MB RAM
- لو كبر المشروع: ~$5-10/شهر على Railway

---

## 🛡️ الأمان

- مفيش كلمة سر بتتحفظ
- كل session مؤقتة (QR login جديد كل مرة)
- الـ browser بيتقفل بعد انتهاء الـ session

---

## 🔧 لو TikTok غيّر الـ Selectors

في `server.js` فيه `SELECTORS` object في الأول — بيحتوي على array من البدائل لكل عنصر.
لو عنصر اتغير، ضيف السيليكتر الجديد في البداية.
