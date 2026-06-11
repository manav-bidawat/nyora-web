import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * Liliana template (key "liliana").
 * Concrete sources: DocTruyen5s, MangaKoma01, Raw1001, ManhuaGold, MangaSect, ManhuaPlus.org.
 *
 * Behavior ported from LilianaParser.kt (PagedMangaParser):
 *  - list:     /search/{page}/?keyword=<q>   OR   /filter/{page}/?sort=...&genres=...&notGenres=...&status=...
 *              list items: div#main div.grid > div  (title in .text-center a, cover img)
 *  - details:  description div#syn-target, large cover .a1 > figure img,
 *              tags .a2 div > a[rel='tag'].label, author from .y6x11p i.fas.fa-user + span.dt,
 *              state from .y6x11p i.fas.fa-rss + span.dt, chapters ul > li.chapter (reversed -> oldest first),
 *              uploadDate from time[datetime] (epoch SECONDS -> *1000).
 *  - pages:    chapter page contains `const CHAPTER_ID = <n>;` inside a <script>. Then GET
 *              /ajax/image/list/chap/<id> -> JSON {status, msg, html}; parse html, each <div> has an <img src>.
 *              (DocTruyen5s variant uses div.separator a[href]; we fall back to that shape too.)
 *
 * All tunable selectors / URL fragments live as instance fields so per-source `overrides`
 * can patch them via Object.assign.
 */
export class LilianaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // ---- list ----
        this.searchPath = "/search/";        // + page + "/?keyword="
        this.filterPath = "/filter/";        // + page + "/?sort=..."
        this.selectMangaList = "div#main div.grid > div";
        this.selectMangaListTitle = ".text-center a";

        // ---- details ----
        this.selectDescription = "div#syn-target";
        this.selectCover = ".a1 > figure img";
        this.selectTag = ".a2 div > a[rel='tag'].label";
        this.selectAuthor = "div.y6x11p i.fas.fa-user + span.dt";
        this.selectState = "div.y6x11p i.fas.fa-rss + span.dt";
        this.selectChapter = "ul > li.chapter";

        // ---- pages ----
        this.chapterIdMarker = "const CHAPTER_ID = ";
        this.ajaxImageListPath = "/ajax/image/list/chap/"; // + chapterId
        this.selectPageContainer = "div.separator a";       // DocTruyen5s shape (preferred when present)

        // ---- state keyword sets (from LilianaParser.kt) ----
        this.ongoing = new Set(["on-going", "đang tiến hành", "進行中"]);
        this.finished = new Set(["completed", "hoàn thành", "完了"]);
        this.abandoned = new Set(["canceled", "đã huỷ bỏ", "キャンセル"]);
        this.paused = new Set(["on-hold", "tạm dừng", "一時停止"]);
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Source variants sometimes need newer selector syntax. Fall
                // through to simpler selectors when the DOM rejects one.
            }
        }
        return [];
    }

    queryFirst(el, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const found = el.querySelector(selector);
                if (found) return found;
            } catch {
                // ignore unsupported selector and try the next
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    sortParam(order) {
        switch (order) {
            case SortOrder.UPDATED: return "latest-updated";
            case SortOrder.POPULARITY: return "views";
            case SortOrder.ALPHABETICAL: return "az";
            case SortOrder.ALPHABETICAL_DESC: return "za";
            case SortOrder.NEWEST: return "new";
            case SortOrder.NEWEST_ASC: return "old";
            case SortOrder.RATING: return "score";
            default: return "latest-updated";
        }
    }

    stateParam(state) {
        switch (state) {
            case MangaState.ONGOING: return "on-going";
            case MangaState.FINISHED: return "completed";
            case MangaState.PAUSED: return "on-hold";
            case MangaState.ABANDONED: return "canceled";
            default: return "all";
        }
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        let url = `https://${this.domain}`;
        if (filter.query) {
            url += `${this.searchPath}${page}/?keyword=${encodeURIComponent(filter.query)}`;
        } else {
            url += `${this.filterPath}${page}/?sort=${this.sortParam(order)}`;
            const tags = (filter.tags || []).map((t) => (t && t.key != null ? t.key : t)).filter(Boolean);
            const tagsExclude = (filter.tagsExclude || []).map((t) => (t && t.key != null ? t.key : t)).filter(Boolean);
            url += `&genres=${tags.join(",")}`;
            url += `&notGenres=${tagsExclude.join(",")}`;
            const states = filter.states || [];
            if (states.length) {
                url += `&status=${this.stateParam(states[0])}`;
            }
        }

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            this.selectMangaList,
            "div#main div.grid > div",
            "div.grid > div",
            "div.manga-lists div.grid > div",
        ]);
        const mangaList = [];
        const seen = new Set();

        for (const el of elements) {
            const a = el.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href || href.startsWith("#")) continue;
            const relHref = this.toRelativeUrl(href);
            if (seen.has(relHref)) continue;

            const titleEl = this.queryFirst(el, [this.selectMangaListTitle, ".text-center a", "h3 a", ".tooltip a", "a[title]"]);
            const img = el.querySelector("img");
            const title = (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent || "")).trim();
            if (!title) continue;

            seen.add(relHref);
            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE
            }));
        }
        return mangaList;
    }

    parseState(text) {
        const t = (text || "").trim().toLowerCase();
        if (!t) return undefined;
        if (this.ongoing.has(t)) return MangaState.ONGOING;
        if (this.finished.has(t)) return MangaState.FINISHED;
        if (this.paused.has(t)) return MangaState.PAUSED;
        if (this.abandoned.has(t)) return MangaState.ABANDONED;
        return undefined;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const descEl = this.queryFirst(doc, [this.selectDescription, "div#syn-target", ".summary__content", ".description"]);
        const description = descEl ? descEl.innerHTML : (manga.description || "");

        const coverEl = this.queryFirst(doc, [this.selectCover, ".a1 > figure img", ".a1 img", "figure img"]);
        const largeCoverUrl = coverEl ? this.imageSrc(coverEl) : (manga.largeCoverUrl || manga.coverUrl);

        // Use only the precise Liliana tag selectors. A broad `a[rel='tag']`
        // fallback wrongly matches nav/utility links (Bookmark/History/...) on
        // mirrors that drift from the canonical markup, so we omit it: drifted
        // sites simply yield no tags rather than garbage ones.
        const tagEls = this.queryAll(doc, [this.selectTag, ".a2 div > a[rel='tag'].label", ".a2 a[rel='tag']"]);
        const tags = tagEls.map((a) => {
            const href = a.getAttribute("href") || "";
            const key = href.split("/").filter(Boolean).pop() || a.textContent.trim();
            return { title: a.textContent.trim(), key };
        }).filter((t) => t.title && !/^javascript:/i.test(t.key));

        const authorEl = this.queryFirst(doc, [this.selectAuthor, "div.y6x11p i.fas.fa-user + span.dt"]);
        const authorText = authorEl ? authorEl.textContent.trim() : "";
        const authors = (authorText && authorText.toLowerCase() !== "updating") ? [authorText] : [];

        const stateEl = this.queryFirst(doc, [this.selectState, "div.y6x11p i.fas.fa-rss + span.dt"]);
        const state = this.parseState(stateEl ? stateEl.textContent : "");

        // Chapters: site lists newest-first; reverse to oldest-first.
        const chapterEls = this.queryAll(doc, [
            this.selectChapter,
            "ul > li.chapter",
            "li.chapter",
            "#chapterlist li",
            ".chapter-list li",
        ]).reverse();

        const chapters = chapterEls.map((el, i) => {
            const a = el.querySelector("a");
            if (!a) return null;
            const href = a.getAttribute("href");
            if (!href || href.startsWith("#")) return null;
            const relHref = this.toRelativeUrl(href);
            const timeEl = el.querySelector("time[datetime]");
            const ts = timeEl ? parseInt(timeEl.getAttribute("datetime"), 10) : NaN;
            const uploadDate = Number.isFinite(ts) ? ts * 1000 : 0;
            return new MangaChapter({
                id: relHref,
                url: relHref,
                title: a.textContent.trim() || `Chapter ${i + 1}`,
                number: i + 1,
                volume: 0,
                uploadDate,
                source: this.source
            });
        }).filter((c) => c && c.url);

        return new Manga({
            ...manga,
            title: (this.queryFirst(doc, ["h1", ".manga-name", ".post-title"])?.textContent || manga.title || "").trim() || manga.title,
            description,
            coverUrl: manga.coverUrl || largeCoverUrl,
            largeCoverUrl,
            tags: tags.length ? tags : manga.tags,
            authors: authors.length ? authors : manga.authors,
            state: state || manga.state,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            chapters
        });
    }

    extractChapterId(html, doc) {
        // Preferred: scan the raw HTML for `const CHAPTER_ID = <n>;`.
        const marker = this.chapterIdMarker;
        let idx = html.indexOf(marker);
        if (idx !== -1) {
            const after = html.slice(idx + marker.length);
            const end = after.indexOf(";");
            const candidate = (end === -1 ? after : after.slice(0, end)).trim();
            const m = candidate.match(/\d+/);
            if (m) return m[0];
        }
        // Fallback: walk <script> elements (markup drift / different inline placement).
        for (const script of Array.from(doc.querySelectorAll("script"))) {
            const data = script.textContent || "";
            const i = data.indexOf(marker);
            if (i !== -1) {
                const after = data.slice(i + marker.length);
                const end = after.indexOf(";");
                const candidate = (end === -1 ? after : after.slice(0, end)).trim();
                const m = candidate.match(/\d+/);
                if (m) return m[0];
            }
        }
        // Last resort: any CHAPTER_ID assignment with optional whitespace.
        const loose = html.match(/CHAPTER_ID\s*=\s*["']?(\d+)/);
        return loose ? loose[1] : "";
    }

    parsePageHtml(html) {
        const doc = this.context.parseHTML(html);
        // DocTruyen5s shape: div.separator a[href]; generic shape: each div has an <img src>.
        const anchorEls = this.queryAll(doc, [this.selectPageContainer, "div.separator a"]);
        const pages = [];
        if (anchorEls.length) {
            for (const a of anchorEls) {
                const url = a.getAttribute("href") || a.getAttribute("src") || "";
                if (!url) continue;
                const abs = this.toAbsoluteUrl(url);
                pages.push(new MangaPage({ id: abs, url: abs, source: this.source }));
            }
            if (pages.length) return pages;
        }
        // Generic Liliana shape: ajax html is a list of <div> each wrapping an <img>.
        const imgs = this.queryAll(doc, ["div img", "img"]);
        for (const img of imgs) {
            const url = img.getAttribute("src") || img.getAttribute("data-src") || "";
            if (!url) continue;
            const abs = this.toAbsoluteUrl(url);
            pages.push(new MangaPage({ id: abs, url: abs, source: this.source }));
        }
        return pages;
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const chapterId = this.extractChapterId(html, doc);
        if (chapterId) {
            const ajaxUrl = `https://${this.domain}${this.ajaxImageListPath}${chapterId}`;
            try {
                const respText = await this.context.httpGet(ajaxUrl, this);
                const data = JSON.parse(respText);
                if (data && data.status === false) {
                    throw new Error(data.msg || "Liliana ajax returned status=false");
                }
                if (data && typeof data.html === "string" && data.html.length) {
                    const pages = this.parsePageHtml(data.html);
                    if (pages.length) return pages;
                }
            } catch (e) {
                // Fall through to inline-page extraction below.
                if (String(e.message || "").startsWith("Liliana ajax")) throw e;
            }
        }

        // Fallback: some chapter pages embed images inline (no ajax indirection).
        const inline = this.queryAll(doc, [
            "div.separator a",
            "div#chapter-content img",
            "div.reading-content img",
            "div#readerarea img",
            ".page-break img",
        ]);
        const pages = [];
        for (const el of inline) {
            const url = el.tagName === "A"
                ? (el.getAttribute("href") || "")
                : (el.getAttribute("src") || el.getAttribute("data-src") || "");
            if (!url || url.startsWith("data:")) continue;
            const abs = this.toAbsoluteUrl(url);
            pages.push(new MangaPage({ id: abs, url: abs, source: this.source }));
        }
        return pages;
    }
}
