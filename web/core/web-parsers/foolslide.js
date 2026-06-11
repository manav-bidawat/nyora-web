import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * FoolSlideParser — port of Nyora's FoolSlideParser family (key "foolslide").
 *
 * FoolSlide (and forks like FoOlSlide / Sense) is a classic PHP reader. Pages are
 * exposed as a plain `var pages = [...]` JSON array embedded in the reader page, so
 * everything (list + details + pages) is fully tractable from fetch + DOMParser.
 * No AES, no JS VM, no Cloudflare challenge required for the live sources.
 *
 * Concrete sources differ only by domain and a few URL fragments, so every tunable
 * is an instance field that per-source `overrides` can patch via Object.assign:
 *   RAMAREADER     www.ramareader.it        listUrl "read/directory/"
 *   READNIFTEAM    read-nifteam.info        listUrl "slide/directory/"
 *   MENUDO_FANSUB  www.menudo-fansub.com    listUrl "slide/directory/"
 *   DEATHTOLLSCANS reader.deathtollscans.net  (defaults, pageSize 26)
 *   SEINAGI        reader.seinagi.org.es      (pagination false)
 *   MANGATELLERS   reader.mangatellers.gr     (pagination false)
 */
export class FoolSlideParser extends BaseParser {
    constructor(context, source, domain, pageSize = 25) {
        super(context, source, domain, pageSize);

        // Tunable URL fragments / selectors (per-source overrides patch these).
        this.listUrl = "directory/";
        this.searchUrl = "search/";
        this.pagination = true;       // false if the site has no paginated directory
        this.datePattern = "yyyy.MM.dd";

        this.selectInfo = "div.info";
        this.selectChapter = "div.list div.element";
        this.selectDate = ".meta_r";
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Source variants occasionally need newer selector syntax; fall
                // through to the simpler known shapes when the DOM rejects one.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        const query = filter.query;
        let html;

        if (query) {
            // Search has no pagination on FoolSlide; page > 1 yields nothing.
            if (page > 1) return [];
            const url = `https://${this.domain}/${this.searchUrl}`;
            const body = `search=${encodeURIComponent(query)}`;
            html = await this.context.httpPost(url, body, {
                'Content-Type': 'application/x-www-form-urlencoded'
            }, this);
        } else {
            let url = `https://${this.domain}/${this.listUrl}`;
            if (this.pagination) {
                url += String(page);
            } else if (page > 1) {
                // Non-paginated directories link page 2 back to page 1; stop here.
                return [];
            }
            html = await this.context.httpGet(url, this);
        }

        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            "div.list div.group",
            "div.list .group",
            ".group",
        ]);
        const mangaList = [];

        for (const div of elements) {
            const a = div.querySelector(".title a") || div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const img = div.querySelector("img"); // absent in search results
            const titleEl = div.querySelector(".title a");
            const title = (titleEl ? titleEl.textContent : a.textContent || "").trim();

            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title,
                source: this.source,
                contentRating: this.contentRating()
            }));
        }
        return mangaList;
    }

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        let html = await this.context.httpGet(fullUrl, this);
        let doc = this.context.parseHTML(html);

        // Adult-gate interstitial: an "adult=true" form sits inside div.info.
        const adultForm = doc.querySelector("div.info form");
        if (adultForm) {
            try {
                html = await this.context.httpPost(fullUrl, "adult=true", {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }, this);
                doc = this.context.parseHTML(html);
            } catch {
                // Keep the original doc if the gate POST fails.
            }
        }

        const chapters = this.parseChapters(doc);

        const infoEl = doc.querySelector(this.selectInfo);
        const infoHtml = infoEl ? infoEl.innerHTML : "";
        const infoText = infoEl ? infoEl.textContent.replace(/\s+/g, " ").trim() : "";

        // Description / author heuristics mirror the Kotlin port: labelled info
        // blocks use "<b>Label</b>: value" markup.
        let desc = "";
        let author = null;
        if (infoHtml.includes("Description")) {
            desc = infoText.split("Description: ")[1] || infoText;
            desc = desc.split("Readings")[0].trim();
        } else if (infoHtml.includes("</b>")) {
            const parts = infoText.split(": ");
            desc = (parts.length ? parts[parts.length - 1] : infoText).trim();
        } else {
            desc = infoText;
        }
        if (infoHtml.includes("Author")) {
            author = ((infoText.split("Author: ")[1] || "").split("Art")[0] || "").trim();
        } else if (infoHtml.includes("</b>")) {
            author = ((infoText.split(": ")[1] || "").split("Art")[0] || "").trim();
        }

        const cover = this.imageSrc(doc.querySelector(".thumbnail img")) || manga.coverUrl || "";

        return new Manga({
            ...manga,
            coverUrl: cover,
            largeCoverUrl: cover || manga.largeCoverUrl || manga.coverUrl,
            description: desc || manga.description || "",
            authors: author ? [author] : (manga.authors || []),
            contentRating: this.contentRating(),
            source: this.source,
            chapters
        });
    }

    parseChapters(doc) {
        const elements = this.queryAll(doc, [
            this.selectChapter,
            "div.list div.element",
            "div.list .element",
            ".element",
        ]);
        // Page lists chapters newest-first; reverse so .chapters is oldest-first.
        const reversed = elements.slice().reverse();

        return reversed.map((div, i) => {
            const a = div.querySelector(".title a") || div.querySelector("a");
            if (!a) return null;
            const href = a.getAttribute("href");
            if (!href) return null;
            const relHref = this.toRelativeUrl(href);

            const dateEl = div.querySelector(this.selectDate);
            const dateRaw = dateEl ? dateEl.textContent : "";
            let uploadDate = 0;
            if (dateRaw && dateRaw.includes(", ")) {
                const dateText = dateRaw.split(", ").slice(1).join(", ").trim();
                const parsed = Date.parse(dateText.replace(/\./g, "/"));
                if (!Number.isNaN(parsed)) uploadDate = parsed;
            }

            return new MangaChapter({
                id: relHref,
                url: relHref,
                title: a.textContent.trim(),
                number: i + 1,
                volume: 0,
                uploadDate,
                source: this.source,
                scanlator: null,
                branch: null
            });
        }).filter(Boolean);
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        let html = await this.context.httpGet(fullUrl, this);

        // Some sources (e.g. DeathTollScans) gate the reader behind an adult-content
        // notice; the `var pages` array only appears after an "adult=true" POST.
        let arrText = this.extractPagesArray(html);
        if (!arrText && (html.includes("adult=true") || /Adult content/i.test(html))) {
            try {
                html = await this.context.httpPost(fullUrl, "adult=true", {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }, this);
                arrText = this.extractPagesArray(html);
            } catch {
                // Fall through; return empty if the gate POST fails.
            }
        }

        // Pages are an embedded `var pages = [ {..., "url": "..."}, ... ];` array.
        if (!arrText) return [];

        let images;
        try {
            images = JSON.parse(arrText);
        } catch {
            return [];
        }
        if (!Array.isArray(images)) return [];

        return images.map((p, i) => {
            const url = p && p.url ? this.toAbsoluteUrl(p.url) : "";
            return new MangaPage({
                id: url || String(i),
                url,
                source: this.source
            });
        }).filter((p) => p.url);
    }

    // Pull the JSON array literal out of `var pages = [...]` (last occurrence,
    // matching balanced brackets up to the terminating ';').
    extractPagesArray(html) {
        const marker = "var pages = ";
        const idx = html.lastIndexOf(marker);
        if (idx < 0) return null;
        const start = html.indexOf("[", idx);
        if (start < 0) return null;
        let depth = 0;
        let inStr = false;
        let strCh = "";
        for (let i = start; i < html.length; i++) {
            const ch = html[i];
            if (inStr) {
                if (ch === "\\") { i++; continue; }
                if (ch === strCh) inStr = false;
                continue;
            }
            if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
            if (ch === "[") depth++;
            else if (ch === "]") {
                depth--;
                if (depth === 0) return html.slice(start, i + 1);
            }
        }
        return null;
    }
}
