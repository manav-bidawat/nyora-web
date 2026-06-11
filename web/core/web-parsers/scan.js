import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * ScanParser family (key "scan", 6 concrete sources).
 *
 * Ported from Nyora's org.koitharu.nyora.parsers.site.scan.ScanParser
 * (an abstract PagedMangaParser). Concrete sources:
 *   SCANITA       scanita.org     (it) - getDetails uses a 2-step /manga/<id>/books AJAX
 *   MANGAITALIA   mangaita.io     (it)
 *   MANGATERRA    manga-terra.com (pt)
 *   MANGAFR       www.mangafr.org (fr) - listUrl override "/series"
 *   SCANVFORG     scanvf.org      (fr)
 *   SCANTRAD      scan-trad.com   (fr)
 *
 * All tunables (listUrl, selectors, date pattern, sort map) are instance fields so
 * per-source `overrides` can patch them via Object.assign (e.g. MangaFr sets listUrl
 * to "/series").
 *
 * LIVE-VERIFICATION CAVEAT (see report): as of this writing every domain in this
 * family is dead/parked. scanita.org, mangaita.io and scan-trad.com return HTTP 200
 * but serve a router.parklogic.com parked-domain JS redirector instead of the real
 * site; scanvf.org 302-redirects to survey-smiles.com; manga-terra.com and
 * www.mangafr.org no longer resolve. The selector logic below faithfully mirrors the
 * Kotlin source but could not be confirmed against live HTML.
 */
export class ScanParser extends BaseParser {
    constructor(context, source, domain, pageSize = 0) {
        super(context, source, domain, pageSize);

        // Listing path; MangaFr overrides this to "/series".
        this.listUrl = "/manga";

        // Date format for chapter upload dates (Kotlin: SimpleDateFormat("MM-dd-yyyy")).
        this.datePattern = "MM-dd-yyyy";

        // ---- Listing selectors ----
        this.selectMangaList = ".series, .series-paginated .grid-item-series";
        this.selectMangaListTitle = ".link-series h3, .item-title";

        // ---- Details selectors ----
        this.selectRating = ".card-series-detail .rate-value span, .card-series-about .rate-value span";
        this.selectAuthor = ".card-series-detail .col-6:contains(Autore) div, .card-series-about .mb-3:contains(Autore) a";
        this.selectAltTitle = ".card div.col-12.mb-4 h2, .card-series-about .h6";
        this.selectDescription = ".card div.col-12.mb-4 p, .card-series-desc .mb-4 p";
        this.selectChapter = ".chapters-list .col-chapter, .card-list-chapter .col-chapter";

        // ---- Pages selectors ----
        this.selectPage = ".book-page .img-fluid";

        // Safety cap so a malformed/looping page-list site can't spin forever.
        // Kotlin loops until a page has no .book-page img; we cap at 600 pages.
        this.maxPages = 600;

        // Sort-order -> ?q= value map (Kotlin getListPage `when (order)` block).
        this.sortQueryMap = {
            [SortOrder.UPDATED]: "u",
            [SortOrder.ALPHABETICAL]: "a",
            [SortOrder.POPULARITY]: "p",
            [SortOrder.RATING]: "r",
        };
    }

    // queryAll fallback helper (matches madara.js / mangareader.js convention):
    // try each selector in turn, return the first non-empty match.
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // A DOM impl may reject a :contains()/newer selector; fall through.
            }
        }
        return [];
    }

    querySelector(el, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const found = el.querySelector(selector);
                if (found) return found;
            } catch {
                // Skip unsupported selector syntax.
            }
        }
        return null;
    }

    // Kotlin reads cover from img[data-src] and strips tab chars.
    imageSrc(img) {
        if (!img) return "";
        const url = (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            .replace(/\t/g, "")
            .trim();
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Decode the JSON-escaped HTML fragment the /search endpoint returns.
    // Kotlin: Jsoup.parseBodyFragment(raw.unescapeJson(), domain).
    unescapeJson(raw) {
        if (!raw) return "";
        let s = raw.trim();
        // Search endpoint may wrap the fragment in JSON quotes.
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        return s
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\r")
            .replace(/\\t/g, "\t")
            .replace(/\\\//g, "/")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
    }

    sortValue(order) {
        return this.sortQueryMap[order] || "u";
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        const query = filter.query;
        let isSearch = false;
        let url;

        if (query) {
            // Search endpoint returns a JSON-escaped HTML fragment.
            url = `https://${this.domain}/search?q=${encodeURIComponent(query)}`;
            isSearch = true;
        } else {
            let u = `https://${this.domain}${this.listUrl}?q=${this.sortValue(order)}`;
            const tags = filter.tags || [];
            for (const tag of tags) {
                const key = tag && (tag.key !== undefined ? tag.key : tag);
                if (key) u += `&search[tags][]=${encodeURIComponent(key)}`;
            }
            u += `&page=${page}`;
            url = u;
        }

        const raw = await this.context.httpGet(url, this);
        const html = isSearch ? this.unescapeJson(raw) : raw;
        const doc = this.context.parseHTML(html);

        const elements = this.queryAll(doc, [
            this.selectMangaList,
            ".series",
            ".series-paginated .grid-item-series",
            ".grid-item-series",
        ]);

        const list = [];
        for (const div of elements) {
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const img = div.querySelector("img");
            const titleEl = this.querySelector(div, [this.selectMangaListTitle, ".link-series h3", ".item-title", "h3"]);
            const title = (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent || "")).trim();

            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    // Kotlin chapter title: h5.html().substringBefore("<div").substringAfter("</span>").
    // The <h5> looks like: <span>...</span>Chapter title<div>date</div>.
    extractChapterTitle(h5) {
        if (!h5) return null;
        let html = h5.innerHTML || "";
        const beforeDiv = html.split("<div")[0];
        const afterSpan = beforeDiv.includes("</span>")
            ? beforeDiv.slice(beforeDiv.indexOf("</span>") + "</span>".length)
            : beforeDiv;
        // Strip any residual tags and collapse whitespace.
        const text = afterSpan.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        return text || null;
    }

    // Parse "MM-dd-yyyy" -> epoch millis (0 if unparseable), mirroring parseSafe.
    parseDate(text) {
        if (!text) return 0;
        const m = text.trim().match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (!m) return 0;
        const month = parseInt(m[1], 10) - 1;
        const day = parseInt(m[2], 10);
        const year = parseInt(m[3], 10);
        const d = new Date(year, month, day);
        return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    parseChapters(doc) {
        const elements = this.queryAll(doc, [
            this.selectChapter,
            ".chapters-list .col-chapter",
            ".card-list-chapter .col-chapter",
        ]);
        // Kotlin mapChapters(reversed = true): the DOM is newest-first; we reverse to
        // oldest-first and number 1..N.
        const reversed = elements.slice().reverse();
        const chapters = [];
        for (let i = 0; i < reversed.length; i++) {
            const div = reversed[i];
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const h5 = div.querySelector("h5");
            const dateEl = div.querySelector("h5 div") || doc.querySelector("h5 div");
            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title: this.extractChapterTitle(h5),
                number: i + 1,
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: this.parseDate(dateEl ? dateEl.textContent : ""),
                source: this.source,
            }));
        }
        return chapters;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const ratingEl = this.querySelector(doc, [this.selectRating, ".rate-value span"]);
        let rating = 0;
        if (ratingEl) {
            // ownText: take only the element's own (first) text node.
            const ownText = (ratingEl.childNodes[0] && ratingEl.childNodes[0].nodeType === 3)
                ? ratingEl.childNodes[0].textContent
                : ratingEl.textContent;
            const r = parseFloat((ownText || "").trim());
            if (!isNaN(r)) rating = r / 5;
        }

        const authorEl = this.querySelector(doc, [
            this.selectAuthor,
            ".card-series-detail .col-6:contains(Autore) div",
            ".card-series-about .mb-3:contains(Autore) a",
        ]);
        const author = authorEl ? authorEl.textContent.trim() : null;

        const altEl = this.querySelector(doc, [this.selectAltTitle, ".card div.col-12.mb-4 h2", ".card-series-about .h6"]);
        const altTitle = altEl ? altEl.textContent.trim() : null;

        const descEl = this.querySelector(doc, [this.selectDescription, ".card div.col-12.mb-4 p", ".card-series-desc .mb-4 p"]);
        const description = descEl ? descEl.innerHTML : (manga.description || "");

        // Chapters: inline list first (the common case for most sources).
        let chapters = this.parseChapters(doc);

        // ScanIta-style 2-step fallback: chapters live behind /manga/<id>/books.
        // Detected via a button[data-path] pointing at "/manga/<id>/books".
        if (!chapters.length) {
            try {
                const btn = doc.querySelector(".container-fluid button.w-100[data-path], button[data-path*='/books']");
                const dataPath = btn ? btn.getAttribute("data-path") : null;
                if (dataPath && dataPath.includes("/manga/")) {
                    const id = dataPath.split("/manga/")[1].split("/books")[0];
                    if (id) {
                        const booksHtml = await this.context.httpGet(`https://${this.domain}/manga/${id}/books`, this);
                        const booksDoc = this.context.parseHTML(booksHtml);
                        chapters = this.parseChapters(booksDoc);
                    }
                }
            } catch {
                // Leave chapters empty if the books endpoint is unavailable.
            }
        }

        return new Manga({
            ...manga,
            rating: rating || manga.rating || 0,
            authors: author ? [author] : (manga.authors || []),
            altTitles: altTitle ? [altTitle] : (manga.altTitles || []),
            description,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : (manga.contentRating || ContentRating.SAFE),
            source: this.source,
            chapters,
        });
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url).replace(/\/$/, "");
        const pages = [];
        // Kotlin walks /1, /2, /3 ... until a page yields no .book-page .img-fluid.
        for (let n = 1; n <= this.maxPages; n++) {
            let html;
            try {
                html = await this.context.httpGet(`${fullUrl}/${n}`, this);
            } catch {
                break;
            }
            const doc = this.context.parseHTML(html);
            const img = this.querySelector(doc, [this.selectPage, ".book-page .img-fluid", ".book-page img"]);
            const src = img ? this.imageSrc(img) : "";
            if (!src) break;
            pages.push(new MangaPage({
                id: src,
                url: src,
                source: this.source,
            }));
        }
        return pages;
    }
}
