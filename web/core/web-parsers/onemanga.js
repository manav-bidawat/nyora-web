import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * OneMangaParser — port of Nyora's org.koitharu.nyora.parsers.site.onemanga.OneMangaParser
 * (key "onemanga", ~22 concrete French single-series Elementor/WordPress sites:
 *  bluelockscan.com, dandadan.fr, haikyuu.fr, mashlescan.fr, snkscan.com, ...).
 *
 * Architecture note (matches the Kotlin SinglePageMangaParser base):
 *   Each domain hosts exactly ONE manga (the whole site IS the series). There is no
 *   catalog/search. getList() therefore returns a single Manga built from the homepage,
 *   whose chapters live in #All_chapters, and each chapter page renders its images in
 *   div.elementor-widget-container img.
 *
 * Browser-context notes:
 *   - Covers and page images are lazy-loaded (placeholder SVG in src, real URL in data-src),
 *     so we use the madara.js-style imageSrc() fallback (data-src > data-lazy-src > src) and
 *     drop data:/blob: placeholders for page images.
 *   - Only SortOrder.UPDATED is supported upstream; order/filter are accepted but ignored
 *     because the site has no list/search endpoint.
 */
export class OneMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 1) {
        super(context, source, domain, pageSize);

        // --- Tunable selectors / URL fragments (patchable via per-source overrides) ---
        // Homepage (the single series) selectors:
        this.selectTitle = "ul.elementor-nav-menu li a";
        this.selectCover = "div.elementor-widget-container img";
        this.selectInfoList = "div.elementor-widget-text-editor ul li";
        this.authorLabel = "Auteur(s)";
        this.altTitleLabel = "Nom(s) Alternatif(s)";
        // Chapter list:
        this.selectChaptersHolder = "#All_chapters";
        this.selectChapterLink = "ul li a";
        // Chapter pages:
        this.selectPage = "div.elementor-widget-container img";
    }

    queryAll(doc, selectors) {
        for (const selector of (selectors || []).filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // A source override may use selector syntax this DOM rejects; try the next.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    findInfoValue(doc, label) {
        for (const li of this.queryAll(doc, [this.selectInfoList, "div.elementor-widget-text-editor ul li"])) {
            const text = (li.textContent || "").trim();
            if (text.toLowerCase().includes(label.toLowerCase())) {
                // Strip "Label:" / "Label :" prefix (label punctuation varies per source).
                return text.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:?\\s*`, "i"), "").trim();
            }
        }
        return "";
    }

    // The whole site is one manga; the homepage URL is its canonical id/url.
    async getListPage(page, order, filter) {
        // Single-series source: no pagination, no search. Only page 1 yields content.
        if (page && page > 1) return [];

        const url = `https://${this.domain}`;
        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);

        const title = (this.queryAll(doc, [this.selectTitle])[0]?.textContent || "").trim();
        const coverImg = this.queryAll(doc, [this.selectCover])[0] || null;
        const author = this.findInfoValue(doc, this.authorLabel);
        const altTitle = this.findInfoValue(doc, this.altTitleLabel);

        // Kotlin uses selectLast(...) of the info list as the description.
        const infoItems = this.queryAll(doc, [this.selectInfoList]);
        const description = infoItems.length ? (infoItems[infoItems.length - 1].textContent || "").trim() : "";

        const relUrl = this.toRelativeUrl(url) || "/";

        // If the homepage genuinely has no recognizable series markup, surface nothing
        // rather than an empty card (honesty: don't fabricate a manga).
        if (!title && !this.queryAll(doc, [this.selectChaptersHolder]).length) {
            return [];
        }

        return [new Manga({
            id: relUrl,
            url: relUrl,
            publicUrl: url,
            coverUrl: this.imageSrc(coverImg),
            title: title || this.source.title || this.domain,
            altTitles: altTitle ? [altTitle] : [],
            authors: author ? [author] : [],
            tags: [],
            description,
            state: null,
            source: this.source,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        })];
    }

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url || `https://${this.domain}`);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const holder = this.queryAll(doc, [this.selectChaptersHolder, "#All_chapters", "#all_chapters"])[0] || doc;
        let links = this.queryAll(holder, [this.selectChapterLink, "ul li a", "li a", "a"]);

        // mapChapters(reversed = true): site lists newest-first; Nyora wants oldest-first.
        links = links.reverse();

        const chapters = links.map((a, i) => {
            const href = a.getAttribute("href") || "";
            const relHref = this.toRelativeUrl(href);
            return new MangaChapter({
                id: relHref,
                url: relHref,
                title: (a.textContent || "").trim(),
                number: i + 1,
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: 0,
                source: this.source,
            });
        }).filter((c) => c.url && !c.url.startsWith("#") && !c.url.startsWith("javascript:"));

        return new Manga({ ...manga, chapters });
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const images = this.queryAll(doc, [this.selectPage, "div.elementor-widget-container img"]);
        return images.map((img) => {
            const url = this.imageSrc(img);
            return new MangaPage({
                id: url,
                url,
                preview: null,
                source: this.source,
            });
        }).filter((p) => p.url && !p.url.startsWith("data:") && !p.url.startsWith("blob:"));
    }
}
