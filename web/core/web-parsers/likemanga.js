import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * LikeMangaParser — port of Nyora's LikeMangaParser (key "likemanga").
 *
 * Concrete source: LIKEMANGA (likemanga.ink, en).
 *
 * Site shape (a bespoke PHP/Wordpress-ish template, NOT Madara):
 *  - List/search: GET /?act=search&f[sortby]=...&f[keyword]=...&f[genres]=...&f[status]=...&pageNum=N
 *      cards under "div.card-body div.video"  (title in p.title-manga, link + img inside).
 *  - Details: GET <manga.url> ; chapters in "li.wp-manga-chapter". The page only shows the
 *      first page of chapters; extra pages come from an AJAX JSON endpoint
 *      (?act=ajax&code=load_list_chapter&manga_id=<id>&page_num=<n>) where manga_id is the
 *      trailing "-<digits>" of the manga slug. The .list_chap field is an HTML blob that we
 *      split on "wp-manga-chapter" exactly like the Kotlin reference.
 *  - Pages: GET <chapter.url>. Two variants:
 *      (a) plain "<div.reading-detail> img" with direct src  -> used by current chapters.
 *      (b) an obfuscated variant where "input#next_img_token" carries a JWT-ish value; the
 *          middle segment (value.split('.')[1]) is base64 JSON, whose .data field is itself
 *          base64 of a JSON array of relative image paths. Both layers are plain base64
 *          (decoded here with atob) — fully reproducible in the browser, no AES/VM needed.
 */
export class LikeMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 36) {
        super(context, source, domain, pageSize);

        // --- tunable selectors / fragments (per-source overrides patch these) ---
        this.referer = "https://likemanga.ink/";
        this.searchPath = "/?act=search";

        this.selectMangaList = "div.card-body div.video";
        this.selectMangaTitle = "p.title-manga";

        this.selectChapter = "li.wp-manga-chapter";
        this.selectChapterDate = ".chapter-release-date";
        this.selectNavPages = "#nav_list_chapter_id_detail a:not(.next)";
        this.selectAltTitle = ".list-info li.othername h2";
        this.selectTags = "li.kind a";
        this.selectAuthor = "li.author p";
        this.selectSummary = "#summary_shortened";

        this.ajaxChaptersPath = "/?act=ajax&code=load_list_chapter";
        this.chapterSplitToken = "wp-manga-chapter";

        this.selectReadingImg = ".reading-detail img";
        this.selectImgToken = "div.reading input#next_img_token";

        this.genresPath = "/genres/";

        // sortby query values keyed by SortOrder
        this.sortValues = {
            [SortOrder.UPDATED]: "lastest-chap",
            [SortOrder.NEWEST]: "lastest-manga",
            [SortOrder.POPULARITY]: "top-manga",
        };
        this.defaultSort = "lastest-chap";

        // status query values keyed by MangaState
        this.stateValues = {
            [MangaState.ONGOING]: "in-process",
            [MangaState.FINISHED]: "complete",
            [MangaState.PAUSED]: "pause",
        };
    }

    // --- helpers (mirroring madara.js conventions) ---

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to the next, simpler selector shape.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Site uses Referer-gated responses; thread it on every request.
    get reqHeaders() {
        return { "Referer": this.referer };
    }

    decodeBase64(b64) {
        // Browser-native base64 decode -> UTF-8 string. atob exists in workers/browsers;
        // jsdom/node smoke harness exposes it on globalThis.
        const bin = (typeof atob === "function")
            ? atob(b64)
            : Buffer.from(b64, "base64").toString("binary");
        try {
            // Re-decode as UTF-8 to handle multibyte image paths correctly.
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            return new TextDecoder("utf-8").decode(bytes);
        } catch {
            return bin;
        }
    }

    // --- list / search ---

    async getListPage(page, order, filter) {
        filter = filter || {};
        let url = `https://${this.domain}${this.searchPath}`;

        if (filter.query) {
            url += `&${encodeURIComponent("f[keyword]")}=${encodeURIComponent(filter.query)}`;
        }

        const sortby = this.sortValues[order] || this.defaultSort;
        url += `&${encodeURIComponent("f[sortby]")}=${sortby}`;

        const tags = filter.tags || [];
        if (tags.length) {
            url += `&${encodeURIComponent("f[genres]")}=${encodeURIComponent(tags[0].key)}`;
        }

        const states = filter.states || [];
        if (states.length) {
            const s = this.stateValues[states[0]] || "all";
            url += `&${encodeURIComponent("f[status]")}=${s}`;
        }

        if (page > 1) {
            url += `&pageNum=${page}`;
        }

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            this.selectMangaList,
            "div.card-body div.video",
            "div.video",
        ]);

        const mangaList = [];
        for (const div of elements) {
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const titleEl = div.querySelector(this.selectMangaTitle) ||
                div.querySelector("p.title-manga, .title-manga, .title");
            const img = div.querySelector("img");

            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent || "")).trim(),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return mangaList;
    }

    // --- details ---

    mangaIdFromUrl(url) {
        // Slug ends in "-<digits>" (optionally with a trailing slash). e.g.
        // /revenge-of-the-baskerville-bloodhound-3573/ -> 3573
        const m = String(url || "").replace(/\/+$/, "").match(/-(\d+)$/);
        return m ? m[1] : null;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const mangaId = this.mangaIdFromUrl(manga.url);

        // Determine how many chapter pages exist via the pagination nav.
        let maxPage = 1;
        for (const a of this.queryAll(doc, [this.selectNavPages, "#nav_list_chapter_id_detail a:not(.next)"])) {
            const n = parseInt((a.textContent || "").trim(), 10);
            if (!Number.isNaN(n) && n > maxPage) maxPage = n;
        }

        // Page 1 chapters are embedded in the document.
        let chapters = this.parseChaptersFromDoc(doc);

        // Remaining pages via AJAX (only if we resolved a numeric manga id).
        if (maxPage > 1 && mangaId) {
            for (let p = 2; p <= maxPage; p++) {
                try {
                    const more = await this.loadChapters(mangaId, p);
                    chapters = chapters.concat(more);
                } catch {
                    // A failed page shouldn't kill the whole list.
                }
            }
        }

        // Kotlin reverses the parsed list so chapters end up oldest-first.
        chapters.reverse();

        const altEl = doc.querySelector(this.selectAltTitle);
        const altTitle = altEl ? altEl.textContent.trim() : "";
        const author = this.lastTextOf(doc, this.selectAuthor);
        const summaryEl = doc.querySelector(this.selectSummary);

        const tags = this.queryAll(doc, [this.selectTags, "li.kind a"]).map((a) => {
            const href = a.getAttribute("href") || "";
            const key = href.replace(/\/+$/, "").split("/").pop();
            return { key, title: (a.textContent || "").trim() };
        }).filter((t) => t.key && t.title);

        return new Manga({
            ...manga,
            altTitles: altTitle ? [altTitle] : (manga.altTitles || []),
            tags: tags.length ? tags : (manga.tags || []),
            authors: author ? [author] : (manga.authors || []),
            description: summaryEl ? summaryEl.innerHTML : (manga.description || ""),
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            source: this.source,
            chapters,
        });
    }

    lastTextOf(doc, selector) {
        const els = this.queryAll(doc, [selector]);
        if (!els.length) return "";
        const t = (els[els.length - 1].textContent || "").trim();
        return t && t.toLowerCase() !== "updating" ? t : "";
    }

    chapterNumberFromUrl(url) {
        // .../chapter-165-1773109/ -> "165"
        const m = String(url || "").match(/chapter-([^-/?#]+)/i);
        const n = m ? parseFloat(m[1]) : NaN;
        return Number.isNaN(n) ? 0 : n;
    }

    parseChaptersFromDoc(doc) {
        const els = this.queryAll(doc, [this.selectChapter, "li.wp-manga-chapter"]);
        const out = [];
        for (const li of els) {
            const a = li.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const dateEl = li.querySelector(this.selectChapterDate);
            const rawDate = dateEl ? dateEl.textContent.trim() : "";
            out.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title: (a.textContent || "").trim(),
                number: this.chapterNumberFromUrl(relHref),
                volume: 0,
                uploadDate: this.parseChapterDate(rawDate),
                source: this.source,
            }));
        }
        return out;
    }

    async loadChapters(mangaId, page) {
        const url = `https://${this.domain}${this.ajaxChaptersPath}&manga_id=${mangaId}&page_num=${page}&chap_id=0&keyword=`;
        const text = await this.context.httpGet(url, this);
        let listChap = "";
        try {
            listChap = JSON.parse(text).list_chap || "";
        } catch {
            listChap = "";
        }
        if (!listChap) return [];

        // Mirror the Kotlin string-splitting parse over the HTML blob.
        const parts = listChap.split(this.chapterSplitToken).slice(1);
        const out = [];
        for (const chunk of parts) {
            const href = this.between(chunk, 'href="', '"');
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            // Name is the anchor text; the blob uses .../"> as the close of the opening tag.
            let name = this.between(chunk, '">', "</a>");
            name = (name || "").replace(/<[^>]*>/g, "").trim();
            const rawDate = this.between(chunk, "<i>", "</i>");
            out.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title: name || `Chapter ${this.chapterNumberFromUrl(relHref)}`,
                number: this.chapterNumberFromUrl(relHref),
                volume: 0,
                uploadDate: this.parseChapterDate(rawDate),
                source: this.source,
            }));
        }
        return out;
    }

    between(s, start, end) {
        const i = s.indexOf(start);
        if (i < 0) return "";
        const from = i + start.length;
        const j = s.indexOf(end, from);
        if (j < 0) return "";
        return s.slice(from, j);
    }

    parseChapterDate(raw) {
        if (!raw) return 0;
        const d = raw.toLowerCase().trim();
        if (d === "new" || d.startsWith("today")) {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            return now.getTime();
        }
        // Format "MMMM d, yyyy" e.g. "June 1, 2026" — Date.parse handles it.
        const t = Date.parse(raw);
        return Number.isNaN(t) ? 0 : t;
    }

    // --- pages ---

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);

        const tokenEl = doc.querySelector(this.selectImgToken) ||
            doc.querySelector("input#next_img_token");

        if (tokenEl) {
            const pages = this.decodeTokenPages(doc, tokenEl);
            if (pages.length) return pages;
            // Fall through to plain extraction if decoding yielded nothing.
        }

        const imgs = this.queryAll(doc, [this.selectReadingImg, ".reading-detail img", "div.reading-detail img"]);
        return imgs.map((img, i) => {
            const url = this.imageSrc(img);
            return new MangaPage({ id: url || String(i), url, source: this.source });
        }).filter((p) => p.url);
    }

    decodeTokenPages(doc, tokenEl) {
        try {
            const value = tokenEl.getAttribute("value") || "";
            const middle = value.split(".")[1];
            if (!middle) return [];
            const jsonData = JSON.parse(this.decodeBase64(middle));
            const inner = this.decodeBase64(jsonData.data);
            // inner looks like a JSON array of paths, possibly escaped.
            const cleaned = inner
                .replace(/\\/g, "")
                .replace(/\[/g, "")
                .replace(/\]/g, "")
                .replace(/"/g, "");
            const imgPaths = cleaned.split(",").map((s) => s.trim()).filter(Boolean);

            // CDN base derived from the first reading-detail img: take everything
            // before "manga/", else fall back to that image's origin root.
            const firstImg = doc.querySelector(this.selectReadingImg) || doc.querySelector(".reading-detail img");
            const baseUrl = firstImg ? this.imageSrc(firstImg) : "";
            let cdn = "";
            if (baseUrl) {
                const idx = baseUrl.indexOf("manga/");
                if (idx >= 0) {
                    cdn = baseUrl.slice(0, idx);
                } else {
                    try { cdn = new URL("/", baseUrl).href; } catch { cdn = ""; }
                }
            }

            return imgPaths.map((img, i) => {
                const url = this.concatUrl(cdn, img);
                return new MangaPage({ id: url || String(i), url, source: this.source });
            }).filter((p) => p.url);
        } catch {
            return [];
        }
    }

    concatUrl(base, path) {
        if (!path) return "";
        if (/^https?:\/\//i.test(path)) return path;
        if (!base) return this.toAbsoluteUrl(path);
        return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    }
}
