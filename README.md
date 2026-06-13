<div align="center">

<img src="https://nyora.pages.dev/icon.png" width="112" alt="Nyora"/>

# Nyora — Web

### Read like the world can wait.

A **100% client-side** manga reader that runs entirely in your browser — no backend, no install. Built from scratch as a static SPA; catalogue, search and page parsing all happen client-side.

[![License: Apache 2.0](https://img.shields.io/github/license/Hasan72341/nyora-web?color=blue)](LICENSE)
[![Stars](https://img.shields.io/github/stars/Hasan72341/nyora-web?style=social)](https://github.com/Hasan72341/nyora-web/stargazers)

**[🌍 Open the app — nyoraweb.pages.dev](https://nyoraweb.pages.dev)** · **[🌐 nyora.pages.dev](https://nyora.pages.dev)**

</div>

---

## ✨ Features

- 🌍 **Read in any browser** — desktop or mobile; installable as a **PWA** with an offline app shell.
- 📚 **Hundreds of online sources** — parsed entirely client-side (parser bundles loaded over-the-air, SHA-256 verified, with bundled fallbacks).
- 📖 **Standard & Webtoon reader** — LTR / RTL / vertical, per-title settings.
- 🗂️ Favourites in custom categories + reading history.
- 🔄 **AniList tracking** (direct from the browser) and ☁️ **cloud sync** (Google sign-in; library + source prefs sync per-row via Supabase).
- 🚀 **Self-hostable** — deploys as static files anywhere; the only server-side piece is a tiny Cloudflare Worker that proxies CORS/images.

## ▶️ Use it

Just open **[nyoraweb.pages.dev](https://nyoraweb.pages.dev)** — sign in with Google to sync with your other Nyora devices.

## 🧑‍💻 Run / self-host

It's static — serve `web/` with anything:

```bash
cd web && python3 -m http.server 3000   # → http://127.0.0.1:3000
```

Use `127.0.0.1:3000` (the origin registered for Google sign-in). The CORS/image proxy is a Cloudflare Worker in `cloudflare-worker/` (`npx wrangler deploy`). Any static host works (Cloudflare Pages, Netlify, …). See the sections below for details.

## 🧩 Nyora on every platform

| Platform | Repo | Get it |
|---|---|---|
| 🌍 Web | **nyora-web** *(you are here)* | [nyoraweb.pages.dev](https://nyoraweb.pages.dev) |
| 🤖 Android | [nyora-android](https://github.com/Hasan72341/nyora-android) | [APK](https://github.com/Hasan72341/nyora-android/releases/latest) |
| 🪟 Windows | [nyora-windows](https://github.com/Hasan72341/nyora-windows) | [.exe (x64/ARM64)](https://github.com/Hasan72341/nyora-windows/releases/latest) |
| 🍎 macOS | [nyora-mac](https://github.com/Hasan72341/nyora-mac) | [.dmg / `brew`](https://github.com/Hasan72341/nyora-mac/releases/latest) |
| 🐧 Linux | [nyora-linux](https://github.com/Hasan72341/nyora-linux) | [deb · rpm · curl](https://github.com/Hasan72341/nyora-linux/releases/latest) |
| 📱 iOS / iPadOS | [nyora-ios](https://github.com/Hasan72341/nyora-ios) | [sideload IPA](https://github.com/Hasan72341/nyora-ios/releases/latest) |

## 🏗️ Architecture

```
web/                  ← the SPA (deployed)
  core/               ← api · parser-runtime · sync · ui · library · store
cloudflare-worker/    ← CORS / image proxy (worker.js)
```

- **Parsing runs in-browser** — `core/parser-runtime.js` loads JS parser bundles OTA (SHA-256 verified, bundled fallback) and executes them client-side.
- **CORS bypass = the Cloudflare worker** — manga sites don't send CORS headers, so HTML/images are fetched through `<proxy>/proxy?url=…` / `<proxy>/image?u=…` (which adds the source `Referer`/`UA`). The app tries direct first and only falls back to the worker.
- **Account sync is client-side** — Google Identity → Supabase Auth → per-row library + source-pref sync (last-write-wins).

## 🤝 Contributing

Issues & PRs welcome. ⭐ **Star the repo** if you like Nyora!

## 📄 License

Licensed under the **Apache License 2.0** (see [`LICENSE`](LICENSE)). Original code, built from scratch — source-compatible with Tachiyomi/Kotatsu-style sources but not a fork.

## 🙏 Credits

Developed & maintained by **Md Hasan Raza** — [GitHub](https://github.com/Hasan72341) · [Instagram](https://instagram.com/md_hasan_raza____) · [LinkedIn](https://www.linkedin.com/in/md-hasan-raza) · hasanraza96@outlook.com

> Nyora is not affiliated with any of the manga sources it can access.
