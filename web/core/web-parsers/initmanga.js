import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * InitMangaParser — port of Nyora's InitMangaParser family (key "initmanga").
 *
 * Concrete sources:
 *   - MERLINSCANS  (merlintoon.com)   — default slugs, latestUrlSlug="son-guncellenenler"
 *   - RAGNARSCANS  (ragnarscans.com)  — mangaUrlDirectory="manga",
 *                                       popularUrlSlug="en-cok-takip-edilenler",
 *                                       Cloudflare-protected (interactive challenge).
 *
 * The InitManga WordPress theme renders chapter page images by decrypting an
 * `InitMangaEncryptedChapter` blob client-side (AES-CBC + PBKDF2/SHA-512). The
 * Kotlin parser reproduces that, but it ALSO has a much simpler fast-path that
 * works here: chapter pages expose the first image URL
 * (.../wp-content/uploads/init-manga/<id>/<chapter>/0001.jpg) as a
 * `<link rel="preload" as="image">`, and the remaining pages are sequential
 * (0002.jpg, 0003.jpg, ...). We extract the seed and probe the numeric sequence
 * until a 404, exactly like the Kotlin `maybeExpandSequentialPages` HEAD-probe
 * fallback. This avoids needing the AES decryption / JS VM entirely.
 *
 * See the AES gap note at decryptChapter() — that branch is NOT implemented
 * because (a) the sequential fast-path already yields full page lists on the
 * live source, and (b) PBKDF2/AES decryption + base64-script key extraction is
 * out of scope for a fetch+DOMParser context here. It is documented honestly.
 */
export class InitMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 20) {
        super(context, source, domain, pageSize);

        // Per-source tunables (patched via `overrides` Object.assign).
        this.mangaUrlDirectory = "seri";        // RAGNARSCANS overrides -> "manga"
        this.popularUrlSlug = "seri";           // RAGNARSCANS overrides -> "en-cok-takip-edilenler"
        this.latestUrlSlug = "son-guncellemeler"; // MERLINSCANS overrides -> "son-guncellenenler"
        this.searchPath = "/wp-json/initlise/v1/search";
        this.chapterPagePath = "bolum"; // chapter list pagination: <manga>/bolum/page/N/

        // Selectors.
        this.selectListPanels = "div.manga-item-grid > div.uk-panel";
        this.selectListPanelsFallback = "div.uk-panel";
        this.selectTitle = "#manga-title";
        this.selectDescription = "#manga-description";
        this.selectCover = "div.story-cover-wrap img, a.story-cover img";
        this.selectTags = "#genre-tags a";
        this.selectChapterItem = "div.chapter-item";
        this.selectChapterTitle = "h3, h4";
        this.selectChapterContentImg = "#chapter-content img";

        // Sequential page expansion bounds (mirrors Kotlin MAX_PROBED_INIT_MANGA_PAGES).
        this.maxProbedPages = 500;
        this.probeBatchSize = 8;

        // Date pattern note: chapter <time datetime="..."> is ISO-8601, which
        // Date.parse handles natively. The Turkish tooltip fallback is informational.

        // Status keyword sets (InitManga doesn't expose status in lists; details
        // page has no reliable status field, so state stays null like the Kotlin).
    }

    // ---- helpers (same conventions as madara.js) -------------------------

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to a simpler selector shape on DOM rejection.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    get contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    // ---- list ------------------------------------------------------------

    async getListPage(page, order, filter = {}) {
        const query = filter && filter.query;
        const tags = (filter && filter.tags) || [];

        if (query) {
            return this.search(page, query);
        }
        if (tags.length) {
            return this.getGenrePage(page, tags[0]);
        }
        if (order === SortOrder.UPDATED) {
            return this.getDirectoryPage(page, this.latestUrlSlug, true);
        }
        return this.getDirectoryPage(page, this.popularUrlSlug, false);
    }

    async getDirectoryPage(page, slug, alwaysPaged) {
        let url = `https://${this.domain}/${String(slug).replace(/^\/+|\/+$/g, "")}/`;
        if (alwaysPaged || page > 1) {
            url += `page/${page}/`;
        }
        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(this.context.parseHTML(html));
    }

    async getGenrePage(page, tag) {
        if (!tag || !tag.key) return [];
        const base = this.toAbsoluteUrl(tag.key).replace(/\/+$/, "");
        const url = page > 1 ? `${base}/page/${page}/` : `${base}/`;
        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(this.context.parseHTML(html));
    }

    async search(page, query) {
        const url = `https://${this.domain}${this.searchPath}?term=${encodeURIComponent(query)}&page=${page}`;
        let raw;
        try {
            raw = await this.context.httpGet(url, this);
        } catch {
            raw = "";
        }
        if (!raw || !raw.trim()) return [];

        // The endpoint can return HTML (fallback theme search) or a JSON array.
        if (raw.trimStart().startsWith("<")) {
            return this.parseMangaList(this.context.parseHTML(raw));
        }

        let list;
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
        if (!Array.isArray(list)) return [];

        return list.map((json) => {
            const fullUrl = (json && json.url) || "";
            if (!fullUrl) return null;
            const relativeUrl = this.toRelativeUrl(fullUrl);
            // Strip HTML tags out of the title field (server returns markup).
            const title = this.stripHtml(json.title || "").trim();
            return new Manga({
                id: relativeUrl,
                url: relativeUrl,
                publicUrl: fullUrl,
                coverUrl: json.thumb || "",
                title,
                source: this.source,
                contentRating: this.contentRating,
            });
        }).filter(Boolean);
    }

    stripHtml(s) {
        return String(s).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');
    }

    parseMangaList(doc) {
        let panels = Array.from(doc.querySelectorAll(this.selectListPanels));
        if (!panels.length) panels = Array.from(doc.querySelectorAll(this.selectListPanelsFallback));

        panels = panels.filter((panel) => {
            if (panel.classList && panel.classList.contains("manga-item-ranking")) return false;
            // Exclude sidebar / top-manga widget panels.
            let parent = panel.parentElement;
            while (parent) {
                const id = parent.id || "";
                const cls = parent.className || "";
                if (id === "im-sidebar" ||
                    /\bsidebar-widget\b/.test(cls) ||
                    /\btop-manga-widget\b/.test(cls)) {
                    return false;
                }
                parent = parent.parentElement;
            }
            return true;
        });

        const seen = new Set();
        const out = [];
        for (const panel of panels) {
            const link = this.findSeriesLink(panel);
            if (!link) continue;
            const href = link.getAttribute("href");
            const relativeUrl = href ? this.toRelativeUrl(href) : "";
            if (!relativeUrl) continue;
            const title = this.extractSeriesTitle(panel, link);
            if (!title) continue;
            if (seen.has(relativeUrl)) continue;
            seen.add(relativeUrl);

            const adult = (panel.textContent || "").includes("18+");
            out.push(new Manga({
                id: relativeUrl,
                url: relativeUrl,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(panel.querySelector("img")),
                title,
                source: this.source,
                contentRating: this.source && this.source.isNsfw
                    ? ContentRating.ADULT
                    : (adult ? ContentRating.ADULT : ContentRating.SAFE),
            }));
        }
        return out;
    }

    findSeriesLink(panel) {
        const dir = this.mangaUrlDirectory;
        return Array.from(panel.querySelectorAll("a[href]")).find((a) => {
            const href = a.getAttribute("href") || "";
            return href.includes(`/${dir}/`) &&
                !href.includes(`/${dir}/page/`) &&
                !href.includes("/bolum");
        }) || null;
    }

    extractSeriesTitle(panel, link) {
        const titleEl = panel.querySelector(
            "h2 a, h2, h3 a, h3, h4 a, h4, a.uk-link-heading, strong.slider-title, strong.uk-h2"
        );
        const fromEl = titleEl && titleEl.textContent.trim();
        if (fromEl) return fromEl;
        const fromAttr = (link.getAttribute("title") || "").trim();
        if (fromAttr) return fromAttr;
        return (link.textContent || "").trim();
    }

    // ---- details ---------------------------------------------------------

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const title = (doc.querySelector(this.selectTitle)?.textContent || "").trim() || manga.title;

        let description = "";
        const descEl = doc.querySelector(this.selectDescription);
        if (descEl) {
            const clone = descEl.cloneNode(true);
            clone.querySelectorAll("a, span").forEach((el) => el.remove());
            description = clone.textContent.trim();
        }

        const cover = this.imageSrc(doc.querySelector(this.selectCover)) || manga.coverUrl;

        const tags = Array.from(doc.querySelectorAll(this.selectTags)).map((a) => ({
            title: (a.textContent || "").trim().replace(/^#/, ""),
            key: this.toRelativeUrl(a.getAttribute("href")),
        })).filter((t) => t.title && t.key);

        const chapters = await this.fetchChapters(manga.url, doc);

        return new Manga({
            ...manga,
            title,
            description,
            coverUrl: cover,
            largeCoverUrl: cover || manga.largeCoverUrl || manga.coverUrl,
            tags: tags.length ? tags : manga.tags,
            contentRating: manga.contentRating === ContentRating.ADULT
                ? ContentRating.ADULT
                : this.contentRating,
            source: this.source,
            chapters,
        });
    }

    async fetchChapters(mangaUrl, firstDoc) {
        const base = this.toAbsoluteUrl(mangaUrl).replace(/\/+$/, "");
        const collected = [];
        const seenUrls = new Set();
        let page = 1;
        let doc = firstDoc;

        // Hard page cap so a misbehaving source can't loop forever.
        while (page <= 200) {
            if (page > 1) {
                const url = `${base}/${this.chapterPagePath}/page/${page}/`;
                let html;
                try {
                    html = await this.context.httpGet(url, this);
                } catch {
                    break;
                }
                doc = this.context.parseHTML(html);
            }

            const items = Array.from(doc.querySelectorAll(this.selectChapterItem));
            if (!items.length) break;

            const before = seenUrls.size;
            for (const el of items) {
                const ch = this.parseChapter(el);
                if (!ch || seenUrls.has(ch.url)) continue;
                seenUrls.add(ch.url);
                collected.push(ch);
            }
            if (seenUrls.size === before) break;
            page++;
        }

        // Sort oldest-first: real chapter numbers ascending, unknown (<=0) last,
        // then by upload date, then by title — mirroring the Kotlin comparator.
        collected.sort((a, b) => {
            const aUnknown = a.number <= 0 ? 1 : 0;
            const bUnknown = b.number <= 0 ? 1 : 0;
            if (aUnknown !== bUnknown) return aUnknown - bUnknown;
            if (a.number !== b.number) return a.number - b.number;
            const ad = a.uploadDate || Number.MAX_SAFE_INTEGER;
            const bd = b.uploadDate || Number.MAX_SAFE_INTEGER;
            if (ad !== bd) return ad - bd;
            return (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase());
        });

        return collected.map((ch, i) => new MangaChapter({ ...ch, index: i }));
    }

    parseChapter(el) {
        const a = el.querySelector("a[href]");
        if (!a) return null;
        const url = this.toRelativeUrl(a.getAttribute("href"));
        if (!url) return null;

        let rawTitle = (el.querySelector(this.selectChapterTitle)?.textContent || "").trim();
        if (!rawTitle) rawTitle = (a.getAttribute("title") || "").trim();
        if (!rawTitle) rawTitle = (el.querySelector("img[alt]")?.getAttribute("alt") || "").trim();
        if (!rawTitle) rawTitle = (a.textContent || "").trim();

        const number = this.extractChapterNumber(url, rawTitle);
        const title = rawTitle || (number != null
            ? `Bölüm ${this.chapterNumberToString(number)}`
            : "");

        return {
            id: url,
            url,
            title,
            number: number != null ? number : 0,
            volume: 0,
            scanlator: null,
            uploadDate: this.parseChapterDate(el),
            branch: null,
            source: this.source,
        };
    }

    extractChapterNumber(url, rawTitle) {
        const re = /(?:bolum|bölüm|chapter|ch)[^0-9]*([0-9]+(?:[.,][0-9]+)?)/i;
        const lastSeg = (url.split("/").filter(Boolean).pop()) || url;
        let m = lastSeg.match(re);
        if (!m && rawTitle) m = rawTitle.match(re);
        if (!m) return null;
        const n = parseFloat(m[1].replace(",", "."));
        return Number.isFinite(n) ? n : null;
    }

    chapterNumberToString(n) {
        return String(n).replace(/\.0$/, "");
    }

    parseChapterDate(el) {
        const dt = el.querySelector("time")?.getAttribute("datetime");
        if (dt) {
            const t = Date.parse(dt);
            if (!Number.isNaN(t)) return t;
        }
        // Tooltip fallback: "title: 29 Mayıs 2026 21:48; pos: top" (Turkish month).
        const tip = el.querySelector("span[uk-tooltip]")?.getAttribute("uk-tooltip");
        if (tip) {
            const title = tip.split("title:")[1];
            if (title) {
                const t = this.parseTurkishDate(title.split(";")[0].trim());
                if (t) return t;
            }
        }
        return 0;
    }

    parseTurkishDate(s) {
        const months = {
            ocak: 0, "şubat": 1, mart: 2, nisan: 3, "mayıs": 4, haziran: 5,
            temmuz: 6, "ağustos": 7, "eylül": 8, ekim: 9, "kasım": 10, "aralık": 11,
        };
        const m = s.match(/(\d{1,2})\s+(\S+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
        if (!m) return 0;
        const month = months[m[2].toLowerCase()];
        if (month == null) return 0;
        const d = new Date(Number(m[3]), month, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
        const t = d.getTime();
        return Number.isNaN(t) ? 0 : t;
    }

    // ---- pages -----------------------------------------------------------

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);

        // 1) Direct <img> inside #chapter-content (present on some chapters).
        let urls = Array.from(doc.querySelectorAll(this.selectChapterContentImg))
            .map((img) => this.imageSrc(img))
            .filter(Boolean);
        urls = this.dedupe(urls);
        if (urls.length) {
            return (await this.maybeExpandSequentialPages(urls)).map((u) => this.toMangaPage(u));
        }

        // 2) Raw init-manga upload URLs anywhere in the HTML (e.g. preload link).
        const re = /https?:\/\/[^\s"'<>]+\/wp-content\/uploads\/init-manga\/[^\s"'<>]+/g;
        urls = this.dedupe(Array.from(html.matchAll(re)).map((mm) => mm[0]));
        if (urls.length) {
            return (await this.maybeExpandSequentialPages(urls)).map((u) => this.toMangaPage(u));
        }

        // 3) Encrypted page blob — see decryptChapter() gap note.
        const decrypted = this.decryptChapter(html, doc);
        if (decrypted && decrypted.length) {
            return (await this.maybeExpandSequentialPages(decrypted)).map((u) => this.toMangaPage(u));
        }

        return [];
    }

    /**
     * GAP (documented honestly): InitManga chapters whose pages are NOT exposed
     * as a sequential 0001.jpg seed embed them in an `InitMangaEncryptedChapter`
     * JSON blob, AES-CBC encrypted with a PBKDF2(SHA-512, 999 iters, 256-bit)
     * key whose passphrase is base64 inside an external `init-main-js-extra`
     * script. Reproducing that requires AES + PBKDF2 + fetching/decoding the key
     * script — out of scope for this fetch+DOMParser port. On the live source
     * (merlintoon.com) the sequential fast-path (paths 1/2 above) already yields
     * complete page lists, so this branch is intentionally a no-op stub.
     */
    decryptChapter(/* html, doc */) {
        return null;
    }

    /**
     * If the chapter exposes a single sequential seed image
     * (.../init-manga/<id>/<chapter>/<NNNN>.<ext>), probe forward (0002, 0003, ...)
     * until a page is missing, building the full list. Mirrors the Kotlin
     * `maybeExpandSequentialPages` + `doesPageExist` HEAD-probe logic, but uses
     * httpGet (the harness context has no httpHead) and treats a thrown
     * non-2xx / HTML body as "missing".
     */
    async maybeExpandSequentialPages(urls) {
        if (urls.length !== 1) return urls;
        const seed = urls[0];
        const m = seed.match(/^(https?:\/\/[^\s"'<>]+\/wp-content\/uploads\/init-manga\/.*\/)(\d+)(\.[A-Za-z0-9]+)$/);
        if (!m) return urls;

        const prefix = m[1];
        const startStr = m[2];
        const suffix = m[3];
        const pad = startStr.length;
        const start = parseInt(startStr, 10);
        if (!Number.isFinite(start)) return urls;

        const expanded = [];
        let n = start;
        let stop = false;
        while (!stop && n <= this.maxProbedPages) {
            const batch = [];
            for (let i = 0; i < this.probeBatchSize && n + i <= this.maxProbedPages; i++) {
                const num = String(n + i).padStart(pad, "0");
                batch.push(prefix + num + suffix);
            }
            const results = await Promise.all(batch.map((u) => this.doesPageExist(u)));
            for (let i = 0; i < batch.length; i++) {
                if (results[i]) {
                    expanded.push(batch[i]);
                } else {
                    stop = true;
                    break;
                }
            }
            n += batch.length;
        }
        return expanded.length ? expanded : urls;
    }

    async doesPageExist(url) {
        try {
            const body = await this.context.httpGet(url, this);
            // A real image fetched as text yields binary garbage (non-empty);
            // a soft-404 HTML page starts with "<". Reject obvious HTML.
            if (typeof body === "string") {
                const head = body.slice(0, 200).trimStart().toLowerCase();
                if (head.startsWith("<!doctype") || head.startsWith("<html")) return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    dedupe(arr) {
        return Array.from(new Set(arr));
    }

    toMangaPage(url) {
        return new MangaPage({ id: url, url, source: this.source });
    }
}
