import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MadthemeParser — port of Nyora's MadthemeParser family (key "madtheme").
 *
 * Concrete sources: MANGAJINX (mgjinx.com), MANHUASCAN (kaliscan.io),
 * MANGAXYZ (mangaxyz.com), MANGAPUMA (mangapuma.com), MANGACUTE (mangacute.com),
 * MANGAFOREST (mangaforest.me). MANGABUDDY is marked @Broken upstream.
 *
 * All tunables are instance fields so per-source `overrides` (sources_madtheme.json)
 * can patch them via Object.assign in the smoke harness / runtime loader.
 */
export class MadthemeParser extends BaseParser {
    constructor(context, source, domain, pageSize = 48) {
        super(context, source, domain, pageSize);

        // List / search
        this.listUrl = "search/"; // MangaJinx overrides to "search"
        this.selectMangaList = "div.book-item";
        this.selectMangaListTitle = "div.meta div.title";

        // Details
        this.selectDesc = "div.section-body.summary p.content";
        this.selectState = "div.detail p:contains(Status) span";
        this.selectAlt = "div.detail div.name h2";
        this.selectTag = "div.detail p:contains(Genres) a";

        // Chapters
        this.selectChapter = "ul#chapter-list li";
        this.selectDate = ".chapter-update";
        this.selectChapterTitle = ".chapter-title";

        // Pages
        this.selectPage = "div#chapter-images img";
        // When set, chapImages URLs are rewritten to https://<imageSubDomain>/manga<...>
        // (mirrors the MangaXyz/MangaPuma/MangaCute/MangaForest subclasses).
        this.imageSubDomain = null;
        this.imageFallbackHost = "sb.mbcdn.xyz";

        this.datePattern = "MMM dd, yyyy";

        // Status word sets (from MadthemeParser base + ManhuaScan).
        this.ongoing = new Set(["on going", "ongoing"]);
        this.finished = new Set(["completed", "complete"]);
    }

    // --- helpers (mirrors madara.js conventions) ---------------------------

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // A source variant may use selector syntax this DOM rejects;
                // fall through to the next, simpler fallback selector.
            }
        }
        return [];
    }

    queryFirst(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const el = doc.querySelector(selector);
                if (el) return el;
            } catch {
                // ignore unsupported selector and try the next
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // ":contains(...)" is a jsoup-ism the DOM rejects; resolve it manually so
    // overrides copied verbatim from the Kotlin still work.
    selectByContains(doc, selector) {
        const m = selector.match(/^(.*?):contains\(([^)]*)\)(.*)$/);
        if (!m) {
            return this.queryAll(doc, [selector]);
        }
        const [, head, needle, tail] = m;
        const headSel = head.trim();
        const needleLc = needle.trim().toLowerCase();
        const containers = headSel ? this.queryAll(doc, [headSel]) : Array.from(doc.querySelectorAll("*"));
        const matched = containers.filter((el) => (el.textContent || "").toLowerCase().includes(needleLc));
        if (!tail.trim()) return matched;
        // Tail like " span" / " a" / " ~ a": resolve siblings/descendants.
        const tailTrim = tail.trim();
        const out = [];
        for (const el of matched) {
            if (tailTrim.startsWith("~")) {
                const sibSel = tailTrim.replace(/^~\s*/, "");
                let sib = el.nextElementSibling;
                while (sib) {
                    try { if (sib.matches(sibSel)) out.push(sib); } catch { /* ignore */ }
                    sib = sib.nextElementSibling;
                }
            } else {
                try { out.push(...Array.from(el.querySelectorAll(tailTrim))); } catch { /* ignore */ }
            }
        }
        return out;
    }

    // --- list / search -----------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        // Normalise listUrl: strip leading/trailing slashes so "search/" and
        // "search" both yield ".../search?...". kaliscan.io 404s on "/search/".
        const listPath = this.listUrl.replace(/^\/+/, "").replace(/\/+$/, "");
        let url = `https://${this.domain}/${listPath}`;
        url += `?page=${page}`;

        if (filter.query) {
            url += `&q=${encodeURIComponent(filter.query)}`;
        }

        url += "&sort=";
        switch (order) {
            case SortOrder.POPULARITY: url += "views"; break;
            case SortOrder.UPDATED: url += "updated_at"; break;
            case SortOrder.ALPHABETICAL: url += "name"; break;
            case SortOrder.NEWEST: url += "created_at"; break;
            case SortOrder.RATING: url += "rating"; break;
            default: url += "updated_at"; break;
        }

        const tags = filter.tags || [];
        if (tags.length) {
            for (const t of tags) {
                const key = t && (t.key || t);
                if (key) url += `&genre[]=${encodeURIComponent(key)}`;
            }
        }

        const states = filter.states || [];
        const state = Array.isArray(states) ? states[0] : states;
        if (state) {
            let s = "all";
            if (state === MangaState.ONGOING) s = "ongoing";
            else if (state === MangaState.FINISHED) s = "completed";
            url += `&status=${s}`;
        }

        const html = await this.context.httpGet(url, this);

        // Some former madtheme sites (mangaxyz/puma/cute/forest) now 301 to the
        // consolidated mangak.io, a Next.js SPA that ships its data in a
        // __NEXT_DATA__ <script>. Detect and parse that instead of the (absent)
        // server-rendered book-item markup.
        const nextData = this.parseNextData(html);
        if (nextData) {
            const list = this.parseNextList(nextData);
            if (list.length) return list;
        }

        return this.parseMangaList(html);
    }

    // --- Next.js (mangak.io) JSON extraction --------------------------------

    parseNextData(html) {
        const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
            || html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
        if (!m) return null;
        try {
            const data = JSON.parse(m[1]);
            return (data && data.props && data.props.pageProps) ? data.props.pageProps : null;
        } catch {
            return null;
        }
    }

    nextItemToManga(item) {
        if (!item || !item.url) return null;
        const href = this.toRelativeUrl(item.url);
        const genres = Array.isArray(item.genres) ? item.genres : [];
        const status = String(item.status || "").toLowerCase();
        let state;
        if (this.ongoing.has(status) || status === "ongoing") state = MangaState.ONGOING;
        else if (this.finished.has(status) || status === "completed") state = MangaState.FINISHED;
        const isAdult = item.isAdult === true || String(item.contentRating || "").toLowerCase() === "adult";
        return new Manga({
            id: href,
            url: href,
            publicUrl: this.toAbsoluteUrl(href),
            coverUrl: item.cover || "",
            largeCoverUrl: item.cover || "",
            title: item.name || item.displayAltName || "",
            altTitles: (item.altNames || []).map((a) => a && a.name).filter(Boolean),
            rating: typeof item.rating === "number" ? item.rating / 5 : 0,
            tags: genres.map((g) => ({ key: g.slug || g.name, title: g.name })).filter((t) => t.key || t.title),
            state,
            description: item.summary || "",
            source: this.source,
            contentRating: (isAdult || this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE,
        });
    }

    parseNextList(pp) {
        const items = pp.ssrItems || pp.items || pp.mangas || [];
        if (!Array.isArray(items)) return [];
        return items.map((it) => this.nextItemToManga(it)).filter(Boolean);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            this.selectMangaList,
            "div.book-item",
            "div.book-detailed-item",
        ]);

        const out = [];
        for (const div of elements) {
            const a = div.querySelector("a[href]");
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href || href.includes("/chapter")) continue;

            const titleEl = this.queryFirst(div, [
                this.selectMangaListTitle,
                "div.meta div.title",
                "div.title",
                ".title",
            ]);
            const title = (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent || "")).trim();

            const img = div.querySelector("img");
            const scoreEl = div.querySelector("div.meta span.score, span.score");
            let rating = 0;
            if (scoreEl) {
                const v = parseFloat((scoreEl.textContent || "").trim());
                if (!Number.isNaN(v)) rating = v / 5;
            }

            out.push(new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(img),
                title,
                rating,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return out;
    }

    // --- details -----------------------------------------------------------

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);

        // Next.js (mangak.io) detail page: data is in __NEXT_DATA__.initialManga.
        const nextData = this.parseNextData(html);
        if (nextData && nextData.initialManga) {
            return this.parseNextDetails(manga, nextData.initialManga);
        }

        const doc = this.context.parseHTML(html);

        const descEl = this.queryFirst(doc, [this.selectDesc, ".summary .content", "div.section-body.summary p.content", ".summary p"]);
        const description = descEl ? descEl.innerHTML : "";

        const stateEl = this.selectByContains(doc, this.selectState)[0]
            || this.selectByContains(doc, ".detail .meta > p > strong:contains(Status) ~ a")[0];
        let state = undefined;
        if (stateEl) {
            const t = (stateEl.textContent || "").trim().toLowerCase();
            if (this.ongoing.has(t)) state = MangaState.ONGOING;
            else if (this.finished.has(t)) state = MangaState.FINISHED;
        }

        const altEl = this.queryFirst(doc, [this.selectAlt, ".detail h2", "div.detail div.name h2"]);
        const altText = altEl ? (altEl.textContent || "").trim() : "";
        const altTitles = altText ? altText.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];

        const tagEls = this.selectByContains(doc, this.selectTag);
        const tags = tagEls.map((a) => {
            const href = (a.getAttribute && a.getAttribute("href")) || "";
            const key = href.replace(/\/$/, "").split("/").pop() || "";
            return { key, title: (a.textContent || "").replace(/,/g, "").trim() };
        }).filter((t) => t.key || t.title);

        const nsfw = !!doc.getElementById("adt-warning");

        const titleEl = this.queryFirst(doc, ["h1", ".detail h1"]);
        const title = titleEl ? (titleEl.textContent || "").trim() : manga.title;

        const coverEl = this.queryFirst(doc, ["#cover img", ".detail .img-cover img", ".book-info img"]);
        const cover = coverEl ? this.imageSrc(coverEl) : manga.coverUrl;

        const chapters = await this.getChapters(doc, manga);

        return new Manga({
            ...manga,
            title,
            description,
            altTitles: altTitles.length ? altTitles : manga.altTitles,
            tags: tags.length ? tags : manga.tags,
            state,
            coverUrl: cover || manga.coverUrl,
            largeCoverUrl: cover || manga.largeCoverUrl || manga.coverUrl,
            contentRating: (nsfw || this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE,
            source: this.source,
            chapters,
        });
    }

    parseNextDetails(manga, im) {
        const genres = Array.isArray(im.genres) ? im.genres : [];
        const tags = genres.map((g) => ({ key: g.slug || g.name, title: g.name })).filter((t) => t.key || t.title);
        const status = String(im.status || "").toLowerCase();
        let state;
        if (this.ongoing.has(status) || status === "ongoing") state = MangaState.ONGOING;
        else if (this.finished.has(status) || status === "completed") state = MangaState.FINISHED;
        const authors = []
            .concat(im.authors || [], im.artists || [])
            .map((a) => (typeof a === "string" ? a : (a && (a.name || a.slug))))
            .filter(Boolean);
        const isAdult = im.isAdult === true || String(im.contentRating || "").toLowerCase() === "adult";

        // Newest-first in the JSON; reverse to oldest-first.
        const rawChapters = Array.isArray(im.chapters) ? im.chapters.slice().reverse() : [];
        const chapters = rawChapters.map((c, i) => {
            const href = this.toRelativeUrl(c.url || "");
            if (!href) return null;
            const num = parseFloat(c.chapterNumber);
            const date = c.updatedAt || c.date;
            return new MangaChapter({
                id: href,
                url: href,
                title: c.name || c.slug || `Chapter ${i + 1}`,
                number: Number.isNaN(num) ? i + 1 : num,
                volume: 0,
                uploadDate: date ? (Date.parse(date) || 0) : 0,
                source: this.source,
            });
        }).filter(Boolean);

        return new Manga({
            ...manga,
            title: im.name || manga.title,
            description: im.summary || manga.description,
            altTitles: (im.altNames || []).map((a) => a && a.name).filter(Boolean),
            tags: tags.length ? tags : manga.tags,
            authors: authors.length ? authors : manga.authors,
            state,
            coverUrl: im.cover || manga.coverUrl,
            largeCoverUrl: im.cover || manga.largeCoverUrl || manga.coverUrl,
            rating: typeof im.rating === "number" ? im.rating / 5 : (manga.rating || 0),
            contentRating: (isAdult || this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE,
            source: this.source,
            chapters,
        });
    }

    /**
     * Resolve the chapter-list HTML. Three known shapes:
     *  - MangaJinx: bookId -> /service/backend/chaplist/?manga_id=<id>
     *  - base/MadthemeParser: bookSlug -> /api/manga/<slug>/chapters?source=detail
     *  - ManhuaScan: chapters already inline in the detail document
     * We try the inline doc first, then bookId, then bookSlug — using whichever
     * yields chapters, so per-source endpoint differences self-heal.
     */
    async getChapters(doc, manga) {
        // 1) Inline chapters already in the detail document (ManhuaScan).
        let chapters = this.parseChapterList(doc);
        if (chapters.length) return chapters;

        const detailHtml = doc.documentElement ? doc.documentElement.outerHTML : "";
        const bookId = (detailHtml.match(/bookId\s*=\s*(\d+)/) || [])[1];
        const bookSlug = (detailHtml.match(/bookSlug\s*=\s*["']([^"']+)["']/) || [])[1];

        const endpoints = [];
        if (bookId) endpoints.push(`https://${this.domain}/service/backend/chaplist/?manga_id=${bookId}`);
        if (bookSlug) endpoints.push(`https://${this.domain}/api/manga/${bookSlug}/chapters?source=detail`);

        for (const url of endpoints) {
            try {
                const html = await this.context.httpGet(url, this);
                const cdoc = this.context.parseHTML(html);
                chapters = this.parseChapterList(cdoc);
                if (chapters.length) return chapters;
            } catch {
                // try next endpoint
            }
        }
        return chapters; // possibly empty
    }

    parseChapterList(doc) {
        const elements = this.queryAll(doc, [
            this.selectChapter,
            "ul#chapter-list li",
            "#chapter-list > li",
            "#chapter-list-inner .chapter-list > li",
            "ul.chapter-list li",
            ".chapter-list li",
        ]);
        if (!elements.length) return [];

        // Site lists newest-first; reverse so the result is oldest-first.
        const reversed = elements.slice().reverse();
        const out = [];
        for (let i = 0; i < reversed.length; i++) {
            const li = reversed[i];
            const a = li.querySelector("a[href]");
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href || href.includes("#")) continue;

            const titleEl = this.queryFirst(li, [this.selectChapterTitle, ".chapter-title"]);
            const title = (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent || "")).replace(/\s+/g, " ").trim();
            const dateEl = this.queryFirst(li, [this.selectDate, ".chapter-update"]);
            const dateText = dateEl ? (dateEl.textContent || "").trim() : "";

            out.push(new MangaChapter({
                id: href,
                url: href,
                title: title || `Chapter ${i + 1}`,
                number: i + 1,
                volume: 0,
                uploadDate: this.parseChapterDate(dateText),
                source: this.source,
            }));
        }
        return out;
    }

    // --- pages -------------------------------------------------------------

    async getPages(chapter) {
        const fullUrl = this.normalizedChapterUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);

        // Next.js (mangak.io) reader: images live in __NEXT_DATA__.initialChapter.images.
        const nextData = this.parseNextData(html);
        if (nextData && nextData.initialChapter && Array.isArray(nextData.initialChapter.images)) {
            const imgs = nextData.initialChapter.images;
            const seen = new Set();
            const out = [];
            for (const u of imgs) {
                const url = (u || "").trim();
                if (!url || seen.has(url)) continue;
                seen.add(url);
                out.push(new MangaPage({ id: url, url, source: this.source }));
            }
            if (out.length) return out;
        }

        const doc = this.context.parseHTML(html);

        const known = new Set();
        const result = [];
        const addPage = (rawUrl) => {
            if (!rawUrl) return;
            const url = this.resolveChapterImageUrl(rawUrl);
            if (!url || known.has(url)) return;
            known.add(url);
            result.push(new MangaPage({ id: url, url, source: this.source }));
        };

        // 1) HTML <img> pages (when the site renders them server-side).
        for (const img of this.queryAll(doc, [this.selectPage, "div#chapter-images img", "#chapter-images img"])) {
            addPage(this.resolveImageElementUrl(img));
        }

        // 2) JS-injected pages: chapImages = "url1,url2,...".
        const scripts = Array.from(doc.querySelectorAll("script")).map((s) => s.textContent || s.innerHTML || "");
        let mainServer = null;
        for (const s of scripts) {
            const m = s.match(/mainServer\s*=\s*"(.*?)"/);
            if (m) { mainServer = m[1]; break; }
        }
        // Fall back to a raw-HTML scan (jsdom sometimes drops inline script text).
        if (!mainServer) {
            const m = html.match(/mainServer\s*=\s*"(.*?)"/);
            if (m) mainServer = m[1];
        }
        const schemePrefix = mainServer && mainServer.startsWith("//") ? "https:" : "";

        let chapImagesRaw = null;
        for (const s of scripts) {
            const m = s.match(/chapImages\s*=\s*['"](.*?)['"]/s);
            if (m) { chapImagesRaw = m[1]; break; }
        }
        if (!chapImagesRaw) {
            const m = html.match(/chapImages\s*=\s*['"](.*?)['"]/s);
            if (m) chapImagesRaw = m[1];
        }

        if (chapImagesRaw) {
            for (const piece of chapImagesRaw.split(",")) {
                const u = piece.trim();
                if (!u) continue;
                if (mainServer) {
                    addPage(`${schemePrefix}${mainServer}${u}`);
                } else {
                    addPage(u);
                }
            }
        }

        return result;
    }

    // <img> with optional onerror="this.src='...'" fallback (base template).
    resolveImageElementUrl(img) {
        const primary = this.imageSrc(img);
        const onerror = (img.getAttribute && img.getAttribute("onerror")) || "";
        const m = onerror.match(/this\.src='([^']*)'/);
        if (!m || !m[1]) return primary;
        const fallback = this.resolveChapterImageUrl(m[1]);
        if (!/^https?:\/\//.test(fallback)) return primary;
        return primary.includes("://s20.") ? fallback : primary;
    }

    resolveChapterImageUrl(rawUrl) {
        const value = (rawUrl || "").trim();
        if (!value) return "";
        if (value.startsWith("https://") || value.startsWith("http://")) {
            return this.applyImageSubDomain(value);
        }
        if (value.startsWith("//")) return this.applyImageSubDomain(`https:${value}`);
        if (value.includes("/manga/") && !value.includes("/wp-content/")) {
            const host = this.imageSubDomain || this.imageFallbackHost;
            return `https://${host}/manga${value.substring(value.indexOf("/manga") + "/manga".length)}`;
        }
        if (value.startsWith("/")) return `https://${this.domain}${value}`;
        return this.toAbsoluteUrl(value);
    }

    // When a per-source imageSubDomain is configured (MangaXyz/Puma/Cute/Forest),
    // rewrite absolute chapImages URLs onto it, preserving everything after /manga.
    applyImageSubDomain(absUrl) {
        if (!this.imageSubDomain) return absUrl;
        const idx = absUrl.indexOf("/manga");
        if (idx === -1) return absUrl;
        return `https://${this.imageSubDomain}/manga${absUrl.substring(idx + "/manga".length)}`;
    }

    normalizedChapterUrl(url) {
        const value = (url || "").trim();
        if (value.startsWith("https://") || value.startsWith("http://")) {
            const schemeEnd = value.indexOf("://");
            const pathStart = value.indexOf("/", schemeEnd + 3);
            if (pathStart === -1) return value;
            const prefix = value.substring(0, pathStart);
            const path = value.substring(pathStart).replace(/\/{2,}/g, "/");
            return prefix + path;
        }
        return this.toAbsoluteUrl(value);
    }

    // --- dates -------------------------------------------------------------

    parseChapterDate(date) {
        if (!date) return 0;
        const d = date.toLowerCase().trim();

        // Relative: "x hours/days/... ago", "2 h", "3 d".
        if (/\bago\b/.test(d) || /\b\d+\s*[hd]\b/.test(d)) {
            return this.parseRelativeDate(d);
        }
        if (d.startsWith("today")) {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            return now.getTime();
        }
        // Absolute "MMM dd, yyyy" style (e.g. "Jan 05, 2023").
        const t = Date.parse(date.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
        return Number.isNaN(t) ? 0 : t;
    }

    parseRelativeDate(date) {
        const num = parseInt((date.match(/(\d+)/) || [])[1], 10);
        if (Number.isNaN(num)) return 0;
        const now = new Date();
        if (/\bsecond/.test(date)) now.setSeconds(now.getSeconds() - num);
        else if (/\bmin/.test(date)) now.setMinutes(now.getMinutes() - num);
        else if (/\bhour/.test(date) || /\b\d+\s*h\b/.test(date)) now.setHours(now.getHours() - num);
        else if (/\bday/.test(date) || /\b\d+\s*d\b/.test(date)) now.setDate(now.getDate() - num);
        else if (/\bmonth/.test(date)) now.setMonth(now.getMonth() - num);
        else if (/\byear/.test(date)) now.setFullYear(now.getFullYear() - num);
        else return 0;
        return now.getTime();
    }
}
