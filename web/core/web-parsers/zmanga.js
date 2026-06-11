import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * ZMangaParser — port of Nyora's org.koitharu.nyora.parsers.site.zmanga.ZMangaParser
 *
 * "ZManga" is a WordPress manga theme (advanced-search list, div.flexbox2-item cards,
 * div.series-* detail blocks, ul.series-chapterlist chapters, div.reader-area images).
 * Concrete sources in the family: MaidId (www.maid.my.id), ShiroDoujin, KomikIndo.info,
 * YuraManga, Hensekai. All except MaidId are marked @Broken upstream and their domains are
 * dead/redirecting (verified live, see report).
 *
 * Pure fetch + DOMParser; no decryption / JS-VM needed. List, details and pages all work.
 */
export class ZMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 16) {
        super(context, source, domain, pageSize);

        // --- tunable URL fragments / selectors (patchable via source.overrides) ---
        this.listUrl = "advanced-search/";
        this.datePattern = "MMMM d, yyyy";

        // detail page selectors
        this.selectDesc = "div.series-synops";
        this.selectState = "span.status";
        this.selectAlt = "div.series-infolist li:contains(Alt) span";   // :contains is jQuery-ish; handled manually below
        this.selectAut = "div.series-infolist li:contains(Author) span"; // same
        this.selectTag = "div.series-genres a";

        // chapter list selectors
        this.selectDate = "span.date";
        this.selectChapter = "ul.series-chapterlist li";
        this.selectChapterTitle = ".flexch-infoz span:not(.date)";

        // reader selectors
        this.selectPage = "div.reader-area img";

        // state vocab (from Kotlin)
        this.ongoing = new Set(["on going", "ongoing"]);
        this.finished = new Set(["completed"]);
    }

    // madara.js-style multi-selector fallback helper
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some source overrides use selectors a given DOM impl rejects;
                // fall through to the next known shape.
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
                // ignore unsupported selector
            }
        }
        return null;
    }

    // madara.js-style image src extraction with lazy-load fallbacks
    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // ---- list ----

    // https://komikindo.info/advanced-search/?title=the&yearx=2020&status=ongoing&type=Manga&order=update
    async getListPage(page, order, filter = {}) {
        let url = `https://${this.domain}/${this.listUrl}`;
        if (page > 1) url += `page/${page}/`;

        url += "?order=";
        switch (order) {
            case SortOrder.POPULARITY: url += "popular"; break;
            case SortOrder.UPDATED: url += "update"; break;
            case SortOrder.ALPHABETICAL: url += "title"; break;
            case SortOrder.ALPHABETICAL_DESC: url += "titlereverse"; break;
            case SortOrder.NEWEST: url += "latest"; break;
            case SortOrder.RATING: url += "rating"; break;
            default: url += "update"; break;
        }

        if (filter.query) url += `&title=${encodeURIComponent(filter.query)}`;
        if (filter.year) url += `&yearx=${filter.year}`;

        if (filter.tags && filter.tags.length) {
            for (const t of filter.tags) {
                const key = t && (t.key || t);
                if (key) url += `&${encodeURIComponent("genre[]")}=${key}`;
            }
        }

        if (filter.states && filter.states.length) {
            const st = filter.states[0];
            if (st === MangaState.ONGOING) url += "&status=ongoing";
            else if (st === MangaState.FINISHED) url += "&status=completed";
        }

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            "div.flexbox2-item",
            ".flexbox2-content",
            ".flexbox-item",
        ]);
        const list = [];
        for (const div of elements) {
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);

            const titleEl = this.queryFirst(div, [
                "div.flexbox2-title span:not(.studio)",
                "div.flexbox2-title span.title",
                "div.flexbox2-title",
                ".title",
            ]);
            const img = div.querySelector("img");

            // score is "8.65" out of 10 -> normalise to 0..1*10 like Kotlin (ownText/10)
            const scoreEl = div.querySelector("div.info div.score");
            let rating = 0;
            if (scoreEl) {
                const m = (scoreEl.textContent || "").match(/[\d.]+/);
                if (m) {
                    const v = parseFloat(m[0]);
                    if (!isNaN(v)) rating = v / 10;
                }
            }

            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: titleEl ? titleEl.textContent.trim() : (a.getAttribute("title") || a.textContent || "").trim(),
                rating,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    // ---- details ----

    // Manual replacement for jQuery `:contains(X)` selectors used in the Kotlin source.
    findInfoValue(doc, label) {
        const items = this.queryAll(doc, [
            "div.series-infolist li",
            ".series-infolist li",
            ".infolist li",
        ]);
        const lower = label.toLowerCase();
        for (const li of items) {
            const txt = (li.textContent || "").toLowerCase();
            if (txt.includes(lower)) {
                const span = li.querySelector("span");
                const val = span ? span.textContent.trim() : "";
                if (val) return val;
            }
        }
        return null;
    }

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const descEl = this.queryFirst(doc, [this.selectDesc, "div.series-synops", ".series-synops", ".entry-content"]);
        const description = descEl ? descEl.innerHTML : "";

        const stateEl = this.queryFirst(doc, [this.selectState, "span.status", ".status"]);
        let state;
        if (stateEl) {
            const t = (stateEl.textContent || "").trim().toLowerCase();
            if (this.ongoing.has(t)) state = MangaState.ONGOING;
            else if (this.finished.has(t)) state = MangaState.FINISHED;
        }

        const alt = this.findInfoValue(doc, "Alt");
        const author = this.findInfoValue(doc, "Author");

        const tagEls = this.queryAll(doc, [this.selectTag, "div.series-genres a", ".series-genres a"]);
        const tags = tagEls.map((a) => {
            const href = (a.getAttribute("href") || "").replace(/\/$/, "");
            const key = href.split("/").filter(Boolean).pop() || a.textContent.trim();
            return { key, title: (a.textContent || "").trim().replace(/,/g, ""), source: this.source };
        }).filter((t) => t.key);

        const chapters = this.getChapters(doc);

        const contentRating = doc.getElementById("adt-warning")
            ? ContentRating.ADULT
            : (this.source.isNsfw ? ContentRating.ADULT : (manga.contentRating || ContentRating.SAFE));

        return new Manga({
            ...manga,
            description,
            altTitles: alt ? [alt] : (manga.altTitles || []),
            authors: author ? [author] : (manga.authors || []),
            tags: tags.length ? tags : (manga.tags || []),
            state,
            contentRating,
            source: this.source,
            chapters,
        });
    }

    // Returns chapters oldest-first (Kotlin maps with reversed = true).
    getChapters(doc) {
        const elements = this.queryAll(doc, [
            this.selectChapter,
            "ul.series-chapterlist li",
            ".series-chapterlist li",
            "#chapterlist li",
            ".chapter-list li",
        ]).reverse();

        return elements.map((li, i) => {
            const a = li.querySelector("a");
            if (!a) return null;
            const href = a.getAttribute("href");
            if (!href) return null;
            const relHref = this.toRelativeUrl(href);

            // Title: ".flexch-infoz span:not(.date)" — first span text minus the nested date.
            let title = "";
            const titleEl = this.queryFirst(li, [this.selectChapterTitle, ".flexch-infoz span", "span"]);
            if (titleEl) {
                const dateChild = titleEl.querySelector(".date");
                title = (titleEl.textContent || "").trim();
                if (dateChild) {
                    title = title.replace((dateChild.textContent || "").trim(), "").trim();
                }
            }
            if (!title) {
                title = (a.getAttribute("title") || a.textContent || "").trim();
            }

            const dateEl = this.queryFirst(li, [this.selectDate, "span.date", ".date"]);
            const uploadDate = dateEl ? this.parseChapterDate((dateEl.textContent || "").trim()) : 0;

            return new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: i + 1,
                volume: 0,
                uploadDate,
                source: this.source,
            });
        }).filter((c) => c && c.url && !c.url.includes("#"));
    }

    // ---- pages ----

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const imgs = this.queryAll(doc, [
            this.selectPage,
            "div.reader-area img",
            ".reader-area img",
            "#readerarea img",
            ".main-reading-area img",
        ]);

        return imgs.map((img) => {
            const url = this.imageSrc(img);
            return new MangaPage({
                id: url,
                url,
                source: this.source,
            });
        }).filter((p) => p.url && !p.url.startsWith("data:"));
    }

    // ---- date parsing (port of parseChapterDate / parseRelativeDate) ----

    parseChapterDate(date) {
        if (!date) return 0;
        const d = date.toLowerCase();

        if (/( ago| h| d)$/.test(d)) {
            return this.parseRelativeDate(d);
        }
        if (d.startsWith("today")) {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            return now.getTime();
        }
        const cleaned = date.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
        const ts = Date.parse(cleaned);
        return isNaN(ts) ? 0 : ts;
    }

    parseRelativeDate(date) {
        const m = date.match(/(\d+)/);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        const now = new Date();
        if (/second/.test(date)) now.setSeconds(now.getSeconds() - n);
        else if (/\bmin|minute/.test(date)) now.setMinutes(now.getMinutes() - n);
        else if (/hour|\bh\b/.test(date)) now.setHours(now.getHours() - n);
        else if (/day|\bd\b/.test(date)) now.setDate(now.getDate() - n);
        else if (/month/.test(date)) now.setMonth(now.getMonth() - n);
        else if (/year/.test(date)) now.setFullYear(now.getFullYear() - n);
        else return 0;
        return now.getTime();
    }
}
