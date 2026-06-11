import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MmrcmsParser - port of Nyora's MmrcmsParser family (key "mmrcms").
 *
 * MMRCMS ("My Manga Reader CMS") is a PHP CMS used by many small scanlation
 * sites. The shared template:
 *   - list:    GET /filterList/?page=N&author=&tag=&alpha=<q>&cat=<tag>&sortBy=<o>&asc=<bool>
 *              "latest-release?page=N" for UPDATED sort
 *              entries in `div.media` (cover img, title in div.media-body h5, rating in span)
 *   - details: GET <manga.url>; metadata in `dl.dl-horizontal` with <dt>label</dt><dd>value</dd>
 *              description in `div.well`; chapters in `ul.chapters > li:not(.btn)`
 *   - pages:   GET <chapter.url>; full-size images in `div#all img` (lazy-loaded via data-src)
 *
 * Per-source tunables (selectors, URL fragments, date pattern, label sets) are
 * instance fields so `overrides` from the source descriptor can patch them via
 * Object.assign. A few subclasses (e.g. Onma) use a different markup variant;
 * those variants are handled by id-keyed config resolved in the constructor and
 * by robust queryAll() fallbacks.
 *
 * Browser-only: httpGet returns a STRING, parseHTML returns a DOM Document.
 * jsdom/browsers do NOT support the jQuery `:contains()` pseudo-selector that
 * the Kotlin uses (`dt:contains(Statut)`), so metadata lookup is reimplemented
 * with a text-matching helper (findLabelSibling / findLabelText).
 */
export class MmrcmsParser extends BaseParser {
    constructor(context, source, domain, pageSize = 20) {
        super(context, source, domain, pageSize);

        // --- list / tag endpoints ---
        this.listUrl = "filterList";
        this.tagUrl = "manga-list";
        this.imgUpdated = "/cover/cover_250x350.jpg";

        // --- details metadata labels (the <dt> text to match) ---
        // Defaults are the French template values (the canonical MMRCMS install
        // ships French labels). Per-locale subclasses override these.
        this.selectDesc = "div.well";
        this.labelState = ["Statut"];
        this.labelAlt = ["Autres noms"];
        this.labelAuthor = ["Auteur(s)"];
        this.labelTag = ["Catégories"];

        // --- chapters ---
        this.selectChapter = "ul.chapters > li:not(.btn)";
        this.selectDate = "div.date-chapter-title-rtl";
        this.datePattern = "dd MMM. yyyy";

        // --- pages ---
        this.selectPage = "div#all img";

        // State label sets (matched case-insensitively).
        this.ongoing = new Set([
            "on going", "ongoing", "en cours", "en curso", "devam ediyor", "مستمرة",
        ].map((s) => s.toLowerCase()));
        this.finished = new Set([
            "completed", "completo", "complete", "terminé", "tamamlandı", "مكتملة",
        ].map((s) => s.toLowerCase()));

        // Resolve per-source overrides that the JS sources_*.json fragment does
        // not carry (the Kotlin subclasses set these; the staging descriptor only
        // carries datePattern). Keyed by source id.
        this.applySourceConfig(source && source.id);
    }

    applySourceConfig(id) {
        switch (id) {
            case "ONMA": // Arabic, custom markup variant
                this.variant = "onma";
                this.labelState = ["الحالة"];
                this.labelAlt = ["أسماء أخرى"];
                this.labelAuthor = ["المؤلف"];
                this.labelTag = ["التصنيفات"];
                break;
            case "ANZMANGASHD":
            case "MANGADOOR": // Spanish
                this.labelState = ["Estado"];
                this.labelAlt = ["Otros nombres"];
                this.labelAuthor = ["Autor(es)"];
                this.labelTag = ["Categorías"];
                break;
            case "MANGA_DENIZI": // Turkish
                this.labelState = ["Durum"];
                this.labelAlt = ["Diğer Adları"];
                this.labelAuthor = ["Yazar & Çizer"];
                this.labelTag = ["Kategoriler"];
                this.datePattern = "dd.MM.yyyy";
                break;
            case "READCOMICSONLINE": // English (comics)
                this.labelState = ["Status"];
                this.labelTag = ["Categories"];
                break;
            case "BANANASCAN_COM":
                // bananascans.com ships English labels even though the template
                // defaults are French; widen below in commonEnglishFallback.
                break;
            default:
                break;
        }
        // Always allow English labels as a fallback term so generic/English
        // installs (bananascans, etc.) resolve too, without breaking localized
        // matches above.
        this.labelState = this.labelState.concat(["Status", "Statut", "Estado", "Durum", "Stato"]);
        this.labelAlt = this.labelAlt.concat(["Other names", "Autres noms", "Otros nombres", "Diğer Adları", "Alt"]);
        this.labelAuthor = this.labelAuthor.concat(["Author(s)", "Auteur(s)", "Autor(es)", "Yazar", "Author"]);
        this.labelTag = this.labelTag.concat(["Categories", "Catégories", "Categorías", "Kategoriler", "Genres", "Genre"]);
    }

    // --- helpers (mirror madara.js conventions) ---

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some override selectors aren't valid in every DOM impl; skip.
            }
        }
        return [];
    }

    imageSrc(img) {
        if (!img) return "";
        // MMRCMS lazy-loads page images: real URL in data-src (often with
        // surrounding whitespace), placeholder gif in src.
        let url = img.getAttribute("data-src")
            || img.getAttribute("data-lazy-src")
            || img.getAttribute("data-original")
            || img.getAttribute("src")
            || "";
        url = url.trim();
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
            // If we ended up on a data: URI, try data-src explicitly.
            const ds = (img.getAttribute("data-src") || "").trim();
            if (ds && !ds.startsWith("data:")) url = ds;
            else return "";
        }
        return this.toAbsoluteUrl(url);
    }

    /**
     * Find the metadata value sibling for a label. Mirrors the Kotlin
     * `dt:contains(Label)?.nextElementSibling()` pattern but works without the
     * jQuery `:contains` pseudo-selector. Scans dt/h3 elements for one whose
     * text contains any of the given labels, returns the following <dd> (or
     * nextElementSibling).
     */
    findLabelSibling(doc, labels) {
        const wanted = labels.map((l) => l.toLowerCase());
        const candidates = Array.from(doc.querySelectorAll("dt, h3, .info-label, b, strong"));
        for (const el of candidates) {
            const t = (el.textContent || "").trim().toLowerCase();
            if (!t) continue;
            if (wanted.some((w) => t.includes(w))) {
                // dt -> next dd, h3 -> nested .text or next sibling.
                let sib = el.nextElementSibling;
                // Onma variant: value lives in a nested .text span inside the h3.
                const nested = el.querySelector ? el.querySelector(".text") : null;
                if (nested && (nested.textContent || "").trim()) return nested;
                return sib || null;
            }
        }
        return null;
    }

    findLabelText(doc, labels) {
        const sib = this.findLabelSibling(doc, labels);
        const t = sib ? (sib.textContent || "").trim() : "";
        return t || null;
    }

    sortByParam(order) {
        switch (order) {
            case SortOrder.POPULARITY: return "views&asc=false";
            case SortOrder.POPULARITY_ASC: return "views&asc=true";
            case SortOrder.ALPHABETICAL: return "name&asc=true";
            case SortOrder.ALPHABETICAL_DESC: return "name&asc=false";
            default: return "name&asc=true";
        }
    }

    // --- list ---

    async getListPage(page, order, filter = {}) {
        const query = filter.query || "";
        const tags = filter.tags || [];
        const tagKey = tags.length ? (tags[0].key || tags[0]) : "";

        // Onma uses a dedicated JSON search endpoint that can't be combined with tags.
        if (this.variant === "onma" && query) {
            if (page > 1) return [];
            return this.onmaSearch(query);
        }

        if (order === SortOrder.UPDATED && !query && !tags.length) {
            const url = `https://${this.domain}/latest-release?page=${page}`;
            const html = await this.context.httpGet(url, this);
            return this.parseMangaListUpdated(html);
        }

        // For UPDATED with filters, the Kotlin throws; we degrade to alphabetical.
        const effectiveOrder = (order === SortOrder.UPDATED) ? SortOrder.ALPHABETICAL : order;

        // NOTE: the canonical Kotlin uses "/filterList/?page=" (trailing slash),
        // but live MMRCMS installs answer that with a self-referential 301 that
        // fetch won't follow under a full browser header set. The no-slash form
        // ("/filterList?page=") returns 200 directly, so we use that.
        const url = `https://${this.domain}/${this.listUrl}?page=${page}`
            + `&author=&tag=&alpha=${encodeURIComponent(query)}`
            + `&cat=${encodeURIComponent(tagKey)}`
            + `&sortBy=${this.sortByParam(effectiveOrder)}`;

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    async onmaSearch(query) {
        const url = `https://${this.domain}/search?query=${encodeURIComponent(query)}`;
        let json;
        try {
            json = JSON.parse(await this.context.httpGet(url, this));
        } catch {
            return [];
        }
        const suggestions = (json && json.suggestions) || [];
        return suggestions.map((s) => {
            const slug = s.data;
            const href = `/manga/${slug}`;
            return new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: `https://${this.domain}/uploads/manga/${slug}/cover/cover_250x350.jpg`,
                title: s.value || "",
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            });
        });
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        // Onma uses div.chapter-container; the canonical template uses div.media.
        const elements = this.queryAll(doc, [
            "div.media",
            "div.chapter-container",
            ".manga-item",
            ".col-sm-6 .media",
        ]);
        const list = [];
        for (const el of elements) {
            const a = el.querySelector("a[href]");
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href) continue;
            const img = el.querySelector("img");
            const titleEl = el.querySelector("div.media-body h5, h5.media-heading, .media-body h5, h5, h3 a, .manga-name");
            const ratingEl = el.querySelector("span");
            const rating = ratingEl ? this.parseRating(ratingEl) : 0;
            list.push(new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(img),
                title: titleEl ? titleEl.textContent.trim() : (a.getAttribute("title") || a.textContent || "").trim(),
                rating,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    parseRating(span) {
        // Kotlin: ownText().toFloatOrNull()?.div(5f). Take leading number / 5.
        const m = (span.textContent || "").match(/[\d.]+/);
        if (!m) return 0;
        const v = parseFloat(m[0]);
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 5)) : 0;
    }

    parseMangaListUpdated(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, ["div.manga-item", ".manga-item", "div.media"]);
        const list = [];
        for (const el of elements) {
            const a = el.querySelector("a[href]");
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href) continue;
            const slug = href.replace(/\/+$/, "").split("/").pop();
            const titleEl = el.querySelector("h3 a, h3, .manga-name, h5");
            list.push(new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: `https://${this.domain}/uploads/manga/${slug}${this.imgUpdated}`,
                title: titleEl ? titleEl.textContent.trim() : (a.textContent || "").trim(),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    // --- details ---

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const desc = doc.querySelector(this.selectDesc)?.textContent?.trim() || manga.description || "";

        const stateText = this.findLabelText(doc, this.labelState);
        let state;
        if (stateText) {
            const lc = stateText.toLowerCase();
            if (this.ongoing.has(lc)) state = MangaState.ONGOING;
            else if (this.finished.has(lc)) state = MangaState.FINISHED;
        }

        const alt = this.findLabelText(doc, this.labelAlt);
        const author = this.findLabelText(doc, this.labelAuthor);

        const tagSib = this.findLabelSibling(doc, this.labelTag);
        const tags = [];
        if (tagSib && tagSib.querySelectorAll) {
            for (const a of Array.from(tagSib.querySelectorAll("a"))) {
                const key = (a.getAttribute("href") || "").replace(/\/+$/, "").split("/").pop()
                    .replace(/.*cat=/, "");
                const title = a.textContent.trim();
                if (title) tags.push({ key: key || title, title });
            }
        }

        const chapters = this.parseChapters(doc);

        return new Manga({
            ...manga,
            title: doc.querySelector("h2.listmanga-header, h1, .widget-title")?.textContent?.trim() || manga.title,
            description: desc,
            altTitles: alt ? [alt] : (manga.altTitles || []),
            authors: author ? [author] : (manga.authors || []),
            tags: tags.length ? tags : (manga.tags || []),
            state: state || manga.state,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            chapters,
        });
    }

    parseChapters(doc) {
        const elements = this.queryAll(doc, [
            this.selectChapter,
            "ul.chapters > li:not(.btn)",
            "ul.chapters li",
            "li.volume-0, li.volume-1",
            ".chapters li",
        ]).filter((li) => !(li.classList && li.classList.contains("btn")));

        // Kotlin builds oldest-first (mapChapters reversed=true). Site lists
        // newest-first, so reverse to get oldest-first and number 1..N.
        const ordered = elements.slice().reverse();
        const chapters = [];
        ordered.forEach((li, i) => {
            const a = li.querySelector("a[href]");
            if (!a) return;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href || href.includes("#")) return;
            const titleEl = li.querySelector("h5");
            const dateText = li.querySelector(this.selectDate)?.textContent?.trim()
                || li.querySelector("div.action div, .date-chapter-title-rtl")?.textContent?.trim();
            chapters.push(new MangaChapter({
                id: href,
                url: href,
                title: titleEl ? titleEl.textContent.replace(/\s+/g, " ").trim() : a.textContent.trim(),
                number: i + 1,
                volume: 0,
                uploadDate: this.parseDate(dateText),
                source: this.source,
            }));
        });
        return chapters;
    }

    parseDate(text) {
        if (!text) return 0;
        const t = text.trim();
        // dd.MM.yyyy
        let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]) || 0;
        // dd MMM. yyyy  e.g. "05 Jul. 2020"
        m = t.match(/^(\d{1,2})\s+([A-Za-zçÇ.]+)\.?\s+(\d{4})$/);
        if (m) {
            const mo = this.monthIndex(m[2]);
            if (mo >= 0) return Date.UTC(+m[3], mo, +m[1]) || 0;
        }
        const parsed = Date.parse(t);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    monthIndex(name) {
        const n = name.replace(/\./g, "").slice(0, 3).toLowerCase();
        const en = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        let i = en.indexOf(n);
        if (i >= 0) return i;
        // French / Spanish / Turkish abbreviations.
        const intl = {
            jan: 0, fév: 1, fev: 1, mar: 2, avr: 3, mai: 4, jui: 5, juil: 6,
            aoû: 7, aou: 7, sep: 8, oct: 9, nov: 10, déc: 11, dec: 11,
            ene: 0, abr: 3, ago: 7, dic: 11,
            oca: 0, şub: 1, sub: 1, nis: 3, haz: 5, tem: 6, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
        };
        return n in intl ? intl[n] : -1;
    }

    // --- pages ---

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);
        const imgs = this.queryAll(doc, [
            this.selectPage,
            "div#all img",
            "#all img",
            "div.viewer-cnt img",
            "#all .img-responsive",
            ".chapter-img img",
        ]);
        return imgs.map((img) => {
            const url = this.imageSrc(img);
            return new MangaPage({
                id: url,
                url,
                source: this.source,
            });
        }).filter((p) => p.url);
    }
}
