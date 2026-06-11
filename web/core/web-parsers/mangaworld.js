import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangaWorldParser — port of Nyora's MangaWorldParser family.
 *
 * Sources (key "mangaworld"):
 *   - MANGAWORLD       (mangaworld.mx, locale it)
 *   - MANGAWORLDADULT  (mangaworldadult.net, locale it)
 *
 * Both share the same WordPress-ish "comics-grid" theme. Listing happens via the
 * /archive endpoint (or the homepage for the UPDATED order with no filters);
 * details/chapters come from the manga page DOM; reader pages render server-side
 * as plain <img> tags (with ?style=list forcing the long-strip layout), so the
 * whole chain works in a fetch + DOMParser browser context with no decryption,
 * JS VM, or AJAX endpoints required.
 */
export class MangaWorldParser extends BaseParser {
    constructor(context, source, domain, pageSize = 16) {
        super(context, source, domain, pageSize);

        // Both apex domains (mangaworld.mx / mangaworldadult.net) issue a 301 to
        // their "www." canonical host that some fetch stacks won't auto-follow.
        // Force "www." for bare apex domains so every request lands on the host
        // that actually serves 200. (Disable per-source via overrides if needed.)
        this.wwwForce = true;

        // --- Listing -------------------------------------------------------
        this.archivePath = "/archive";                 // search/filter endpoint
        this.selectMangaEntry = ".comics-grid .entry"; // one card per series
        this.selectEntryLink = "a.thumb";              // series href + cover wrapper
        this.selectEntryTitle = ".name a.manga-title"; // series title
        this.selectEntryCover = ".thumb img";          // cover <img>
        this.selectEntryAuthor = ".author a";          // author name
        this.selectEntryStatus = ".status a";          // localized status text
        this.selectEntryGenres = ".genres a[href*='genre=']"; // genre links

        // --- Details -------------------------------------------------------
        this.selectAltTitle = ".meta-data .font-weight-bold"; // scanned for "Titoli alternativi"
        this.altTitleLabel = "Titoli alternativi";
        this.descriptionId = "noidungm";               // <div id="noidungm">
        this.selectChapterWrap = ".chapters-wrapper .chapter a";
        this.selectChapterTitle = "span.d-inline-block";
        this.selectChapterDate = ".chap-date";
        this.stylePage = "?style=list";

        // --- Pages ---------------------------------------------------------
        this.selectWebtoonPages = "img.page-image";
        this.selectMangaPages = "#page img.img-fluid"; // scoped to reader; avoids the logo
        this.selectMangaPagesFallback = "img.img-fluid";

        // Localized status labels (Italian) -> MangaState
        this.statusMap = {
            "in corso": MangaState.ONGOING,
            "finito": MangaState.FINISHED,
            "droppato": MangaState.ABANDONED,
            "in pausa": MangaState.PAUSED,
        };

        // Localized month names for date parsing (Italian).
        this.monthNames = {
            "gennaio": 0, "febbraio": 1, "marzo": 2, "aprile": 3,
            "maggio": 4, "giugno": 5, "luglio": 6, "agosto": 7,
            "settembre": 8, "ottobre": 9, "novembre": 10, "dicembre": 11,
        };
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some DOM implementations reject newer selector syntax; try next.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Canonical request host. Prepends "www." for bare apex domains because the
    // apex 301 isn't reliably followed by every fetch implementation.
    requestHost() {
        const host = (this.domain || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (this.wwwForce && host && !host.startsWith("www.") && host.split(".").length === 2) {
            return `www.${host}`;
        }
        return host;
    }

    // Absolute URL on the canonical request host (for fetches). Storage URLs are
    // still kept relative via this.toRelativeUrl(...).
    reqUrl(relOrAbs) {
        if (!relOrAbs) return `https://${this.requestHost()}/`;
        const rel = this.toRelativeUrl(relOrAbs);
        return `https://${this.requestHost()}${rel.startsWith("/") ? "" : "/"}${rel}`;
    }

    // "31 Maggio 2026" -> epoch millis (best-effort; 0 if unparseable).
    parseDate(text) {
        if (!text) return 0;
        const m = text.trim().toLowerCase().match(/(\d{1,2})\s+([a-zàèéìòù]+)\s+(\d{4})/);
        if (!m) return 0;
        const day = parseInt(m[1], 10);
        const month = this.monthNames[m[2]];
        const year = parseInt(m[3], 10);
        if (month === undefined || isNaN(day) || isNaN(year)) return 0;
        return Date.UTC(year, month, day);
    }

    sortParam(order) {
        switch (order) {
            case SortOrder.POPULARITY: return "most_read";
            case SortOrder.POPULARITY_ASC: return "less_read";
            case SortOrder.ALPHABETICAL: return "a-z";
            case SortOrder.ALPHABETICAL_DESC: return "z-a";
            case SortOrder.NEWEST: return "newest";
            case SortOrder.NEWEST_ASC: return "oldest";
            default: return "a-z";
        }
    }

    stateParam(state) {
        switch (state) {
            case MangaState.ONGOING: return "ongoing";
            case MangaState.FINISHED: return "completed";
            case MangaState.ABANDONED: return "dropped";
            case MangaState.PAUSED: return "paused";
            default: return null;
        }
    }

    async getListPage(page, order, filter = {}) {
        const query = filter.query || "";
        const tags = filter.tags || [];
        const states = filter.states || [];

        // UPDATED with no filters -> homepage feed (mirrors the Kotlin shortcut).
        const noFilters = !query && tags.length === 0 && states.length === 0;
        if (order === SortOrder.UPDATED && noFilters) {
            const html = await this.context.httpGet(`https://${this.requestHost()}/?page=${page}`, this);
            return this.parseMangaList(html);
        }

        let url = `https://${this.requestHost()}${this.archivePath}?&page=${page}`;
        if (query) url += `&keyword=${encodeURIComponent(query)}`;
        for (const t of tags) {
            const key = t && (t.key || t.title || t);
            if (key) url += `&genre=${encodeURIComponent(key)}`;
        }
        url += `&sort=${this.sortParam(order)}`;
        for (const s of states) {
            const sp = this.stateParam(s);
            if (sp) url += `&status=${sp}`;
        }
        if (filter.year) url += `&year=${filter.year}`;

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const entries = this.queryAll(doc, [
            this.selectMangaEntry,
            ".comics-grid .entry",
            ".comics-grid .comic",
            ".entry",
        ]);

        const list = [];
        for (const div of entries) {
            const a = div.querySelector(this.selectEntryLink) || div.querySelector("a.thumb") || div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);

            const titleEl = div.querySelector(this.selectEntryTitle) || div.querySelector(".name a") || div.querySelector(".manga-title");
            const img = div.querySelector(this.selectEntryCover) || div.querySelector("img");
            const authorEl = div.querySelector(this.selectEntryAuthor);

            const tags = [];
            try {
                for (const g of div.querySelectorAll(this.selectEntryGenres)) {
                    const gh = g.getAttribute("href") || "";
                    const key = (gh.split("genre=")[1] || "").split("&")[0];
                    const title = (g.textContent || "").trim();
                    if (key && title) tags.push({ key: decodeURIComponent(key), title });
                }
            } catch { /* ignore genre parse failures */ }

            let state;
            const statusText = div.querySelector(this.selectEntryStatus)?.textContent?.trim()?.toLowerCase();
            if (statusText) state = this.statusMap[statusText];

            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: (titleEl?.textContent || a.getAttribute("title") || "").trim(),
                altTitles: [],
                tags,
                authors: authorEl ? [authorEl.textContent.trim()].filter(Boolean) : [],
                state,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.reqUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        // Alt titles: a bold label "Titoli alternativi:" whose parent holds the value.
        const altTitles = [];
        try {
            for (const label of doc.querySelectorAll(this.selectAltTitle)) {
                if ((label.textContent || "").includes(this.altTitleLabel)) {
                    const parent = label.parentElement;
                    if (parent) {
                        // ownText: parent text minus child element text.
                        let own = parent.textContent || "";
                        for (const c of parent.children) own = own.replace(c.textContent, "");
                        const value = own.split(":").pop().trim();
                        if (value) altTitles.push(value);
                    }
                    break;
                }
            }
        } catch { /* ignore */ }

        const description = doc.getElementById(this.descriptionId)?.textContent?.trim() || manga.description || "";

        // Chapters: site lists newest-first inside .chapters-wrapper; reverse to
        // oldest-first and number 1..N to match the rest of the Nyora stack.
        const chapterEls = this.queryAll(doc, [
            this.selectChapterWrap,
            ".chapters-wrapper .chapter a",
            ".chapters-wrapper a.chap",
            ".chapter a",
        ]).reverse();

        const chapters = chapterEls.map((a, i) => {
            const href = a.getAttribute("href");
            if (!href) return null;
            const absUrl = this.toAbsoluteUrl(href);
            const relUrl = this.toRelativeUrl(absUrl);
            const titleEl = a.querySelector(this.selectChapterTitle);
            const dateEl = a.querySelector(this.selectChapterDate);
            return new MangaChapter({
                id: relUrl,
                url: relUrl + this.stylePage,
                title: (titleEl?.textContent || a.getAttribute("title") || "").trim() || null,
                number: i + 1,
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: this.parseDate(dateEl?.textContent),
                source: this.source,
            });
        }).filter(Boolean);

        return new Manga({
            ...manga,
            altTitles: altTitles.length ? altTitles : manga.altTitles,
            description,
            chapters,
        });
    }

    async getPages(chapter) {
        const html = await this.context.httpGet(this.reqUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);

        // Webtoon layout uses img.page-image; classic manga uses img.img-fluid
        // inside #page. Mirror the Kotlin webtoon-first preference.
        let imgs = Array.from(doc.querySelectorAll(this.selectWebtoonPages));
        if (!imgs.length) {
            imgs = this.queryAll(doc, [this.selectMangaPages, "#page img.img-fluid", this.selectMangaPagesFallback]);
        }

        const pages = [];
        for (const img of imgs) {
            const abs = this.imageSrc(img);
            if (!abs) continue;
            // Skip layout chrome (logos/icons) that may also carry .img-fluid.
            if (/\/(assets|svg|logo)/i.test(abs) && !/\/chapters?\//i.test(abs)) continue;
            // Keep page images ABSOLUTE: they live on a separate CDN host
            // (cdn.mangaworld.mx) and relativizing would lose that host.
            pages.push(new MangaPage({
                id: abs,
                url: abs,
                preview: null,
                source: this.source,
            }));
        }
        return pages;
    }
}
