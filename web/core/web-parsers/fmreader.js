import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * FmreaderParser — port of Nyora's FmreaderParser family (key "fmreader").
 *
 * Concrete sources:
 *   - WELOMA       (weloma.art)      — classic HTML template (this base class).
 *   - WELOVEMANGA  (welovemanga.one) — HTML template, but loads chapters/pages
 *                                      via separate `app/manga/controllers/*.php`
 *                                      AJAX endpoints. Overridden below.
 *   - KLZ9         (klz9.com)        — modern JSON API with SHA-256 signed request
 *                                      headers (x-client-ts / x-client-sig).
 *                                      Toggled via `this.useApi`.
 *
 * Every tunable selector / URL fragment lives as an instance field so the
 * per-source `overrides` block from sources_fmreader.json can patch it via
 * Object.assign (done by the host after construction).
 */
export class FmreaderParser extends BaseParser {
    constructor(context, source, domain, pageSize = 20) {
        super(context, source, domain, pageSize);

        // ---- HTML-template tunables (mirror the Kotlin `open val`s) ----
        this.listUrl = "/manga-list.html";
        this.datePattern = "MMMM d, yyyy";
        this.tagPrefix = "manga-list-genre-";

        this.selectMangaList = "div.thumb-item-flow";
        this.selectMangaTitleLink = "div.series-title a";
        this.selectMangaTitle = "div.series-title";
        this.selectMangaCover = "div.img-in-ratio";

        this.selectDesc = "div.summary-content";
        this.selectState = "ul.manga-info li:contains(Status) a";
        this.selectAlt = "ul.manga-info li:contains(Other names)";
        this.selectAut = "ul.manga-info li:contains(Author(s)) a";
        this.selectTag = "ul.manga-info li:contains(Genre(s)) a";

        this.selectChapter = "ul.list-chapters a";
        this.selectChapterName = "div.chapter-name";
        this.selectDate = "div.chapter-time";
        this.selectPage = "div.chapter-content img";

        // ---- state keyword sets (from the Kotlin template) ----
        this.ongoing = new Set(["on going", "ongoing", "incomplete", "en curso"]);
        this.finished = new Set(["completed", "completado", "complete"]);
        this.abandoned = new Set(["canceled", "cancelled", "drop", "dropped"]);

        // ---- KLZ9 JSON-API mode ----
        // Auto-detect by domain; overridable via overrides if a mirror changes.
        this.useApi = domain === "klz9.com";
        this.apiClientSecret = "KL9K40zaSyC9K40vOMLLbEcepIFBhUKXwELqxlwTEF";
        this.apiListLimit = 36;
    }

    /** Try selectors in order; return first non-empty match list (madara-style). */
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // ":contains()" and similar jQuery selectors are not valid CSS in
                // the DOM. Skip and let the caller fall back to manual scanning.
            }
        }
        return [];
    }

    /**
     * Resolve a reader/cover image src. Fmreader lazy-loads page images with the
     * real URL base64-encoded in `data-img`; covers/list thumbs use plain attrs.
     */
    imageSrc(img) {
        if (!img) return "";
        const encoded = img.getAttribute("data-img");
        if (encoded && /^[A-Za-z0-9+/=\s]+$/.test(encoded)) {
            const decoded = this.decodeBase64(encoded.trim());
            if (decoded && decoded.startsWith("http")) return decoded;
        }
        const url = img.getAttribute("data-src")
            || img.getAttribute("data-lazy-src")
            || img.getAttribute("data-original")
            || img.getAttribute("src")
            || "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return "";
        if (url.endsWith("loading.gif")) return "";
        return this.toAbsoluteUrl(url);
    }

    decodeBase64(str) {
        try {
            if (typeof atob === "function") return atob(str);
            if (typeof Buffer !== "undefined") return Buffer.from(str, "base64").toString("utf8");
        } catch {
            // not valid base64
        }
        return "";
    }

    /**
     * jQuery-style ":contains(text)" emulation: find an <li> in `doc` whose text
     * includes `label`. Returns the matching element or null.
     */
    findInfoItem(doc, label) {
        const items = doc.querySelectorAll("ul.manga-info li");
        const want = label.toLowerCase();
        for (const li of items) {
            if ((li.textContent || "").toLowerCase().includes(want)) return li;
        }
        return null;
    }

    parseState(text) {
        const t = (text || "").trim().toLowerCase();
        if (!t) return undefined;
        if (this.ongoing.has(t)) return MangaState.ONGOING;
        if (this.finished.has(t)) return MangaState.FINISHED;
        if (this.abandoned.has(t)) return MangaState.ABANDONED;
        // partial match for robustness across locale variants
        for (const v of this.ongoing) if (t.includes(v)) return MangaState.ONGOING;
        for (const v of this.finished) if (t.includes(v)) return MangaState.FINISHED;
        for (const v of this.abandoned) if (t.includes(v)) return MangaState.ABANDONED;
        return undefined;
    }

    // ============================ LIST ============================

    async getListPage(page, order, filter) {
        if (this.useApi) return this.getApiListPage(page, order, filter);

        let url = `https://${this.domain}${this.listUrl}?page=${page}`;
        if (filter && filter.query) {
            url += `&name=${encodeURIComponent(filter.query)}`;
        }
        const genres = (filter && filter.tags || []).map(t => t.key).join(",");
        url += `&genre=${genres}`;
        url += `&ungenre=`;
        url += `&sort=`;
        switch (order) {
            case SortOrder.POPULARITY: url += "views&sort_type=DESC"; break;
            case SortOrder.POPULARITY_ASC: url += "views&sort_type=ASC"; break;
            case SortOrder.UPDATED: url += "last_update&sort_type=DESC"; break;
            case SortOrder.UPDATED_ASC: url += "last_update&sort_type=ASC"; break;
            case SortOrder.ALPHABETICAL: url += "name&sort_type=ASC"; break;
            case SortOrder.ALPHABETICAL_DESC: url += "name&sort_type=DESC"; break;
            default: url += "last_update&sort_type=DESC"; break;
        }
        url += `&m_status=`;
        const state = (filter && filter.states && filter.states.length === 1) ? filter.states[0] : null;
        if (state === MangaState.ONGOING) url += "2";
        else if (state === MangaState.FINISHED) url += "1";
        else if (state === MangaState.ABANDONED) url += "3";

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const items = this.queryAll(doc, [this.selectMangaList, "div.thumb-item-flow"]);
        const mangaList = [];
        for (const div of items) {
            const a = div.querySelector(this.selectMangaTitleLink) || div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const titleEl = div.querySelector(this.selectMangaTitle);
            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.extractCover(div),
                title: titleEl ? titleEl.textContent.trim() : (a.textContent || "").trim(),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return mangaList;
    }

    extractCover(div) {
        const imgDiv = div.querySelector(this.selectMangaCover);
        if (!imgDiv) {
            return this.imageSrc(div.querySelector("img"));
        }
        const dataBg = imgDiv.getAttribute("data-bg");
        if (dataBg) return this.toAbsoluteUrl(dataBg);
        const style = imgDiv.getAttribute("style") || "";
        const m = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        if (m) return this.toAbsoluteUrl(m[1]);
        return this.imageSrc(imgDiv.querySelector("img"));
    }

    // ============================ DETAILS ============================

    async getDetails(manga) {
        if (this.useApi) return this.getApiDetails(manga);

        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const descEl = doc.querySelector(this.selectDesc);
        const description = descEl ? descEl.innerHTML : "";

        const stateLi = this.findInfoItem(doc, "Status");
        const stateLink = stateLi ? stateLi.querySelector("a") : null;
        const state = this.parseState(stateLink ? stateLink.textContent : (stateLi ? stateLi.textContent : ""));

        const altLi = this.findInfoItem(doc, "Other name");
        const altTitle = altLi
            ? altLi.textContent.replace(/Other names?\s*\(?s?\)?:?/i, "").trim()
            : "";

        const autLi = this.findInfoItem(doc, "Author");
        const authorLink = autLi ? autLi.querySelector("a") : null;
        const author = authorLink ? authorLink.textContent.trim() : (autLi ? autLi.textContent.replace(/Author\(s\):?/i, "").trim() : "");

        const tagLi = this.findInfoItem(doc, "Genre");
        const tags = [];
        if (tagLi) {
            for (const a of tagLi.querySelectorAll("a")) {
                const href = a.getAttribute("href") || "";
                const key = href.split(this.tagPrefix).pop().replace(/\.html$/, "");
                tags.push({ key, title: a.textContent.trim(), source: this.source });
            }
        }

        const chapters = await this.getChapters(manga, doc);

        return new Manga({
            ...manga,
            description,
            altTitles: altTitle ? [altTitle] : (manga.altTitles || []),
            authors: author ? [author] : (manga.authors || []),
            tags: tags.length ? tags : (manga.tags || []),
            state: state || manga.state,
            chapters,
        });
    }

    // ============================ CHAPTERS ============================

    /**
     * @param {Manga} manga  the manga being detailed (for sources that need its url)
     * @param {Document} doc the already-parsed details document
     */
    async getChapters(manga, doc) {
        const anchors = this.queryAll(doc, [this.selectChapter, "ul.list-chapters a", "div.list-chapters a"]);
        return this.buildChapters(anchors);
    }

    /** Build oldest-first chapter list from a set of <a> elements (newest-first in DOM). */
    buildChapters(anchors) {
        const reversed = anchors.slice().reverse(); // DOM is newest-first -> oldest-first
        const chapters = [];
        reversed.forEach((a, i) => {
            const href = a.getAttribute("href");
            if (!href || href.includes("#")) return;
            const relHref = this.toRelativeUrl(href);
            const nameEl = a.querySelector(this.selectChapterName);
            const dateEl = a.querySelector(this.selectDate);
            const title = nameEl ? nameEl.textContent.trim() : a.textContent.trim();
            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: i + 1,
                volume: 0,
                uploadDate: this.parseChapterDate(dateEl ? dateEl.textContent.trim() : ""),
                source: this.source,
            }));
        });
        return chapters;
    }

    // ============================ PAGES ============================

    async getPages(chapter) {
        if (this.useApi) return this.getApiPages(chapter);

        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);
        return this.extractPages(doc);
    }

    extractPages(doc) {
        const imgs = this.queryAll(doc, [this.selectPage, "div.chapter-content img", "div.reading-content img"]);
        const pages = [];
        for (const img of imgs) {
            const url = this.imageSrc(img);
            if (!url) continue; // skip lazy placeholders / ad images without a real source
            pages.push(new MangaPage({ id: url, url, source: this.source }));
        }
        return pages;
    }

    // ================== KLZ9 JSON API IMPLEMENTATION ==================

    async createApiHeaders() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = await this.sha256Hex(`${timestamp}.${this.apiClientSecret}`);
        return {
            "Content-Type": "application/json",
            "x-client-ts": timestamp,
            "x-client-sig": signature,
        };
    }

    async sha256Hex(message) {
        const cryptoObj = (typeof crypto !== "undefined" && crypto.subtle) ? crypto
            : (typeof globalThis !== "undefined" ? globalThis.crypto : null);
        if (cryptoObj && cryptoObj.subtle) {
            const enc = new TextEncoder().encode(message);
            const buf = await cryptoObj.subtle.digest("SHA-256", enc);
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
        // Node fallback (browsers always have crypto.subtle on https origins).
        const nodeCrypto = await import("node:crypto");
        return nodeCrypto.createHash("sha256").update(message).digest("hex");
    }

    async apiGetJson(url) {
        const headers = await this.createApiHeaders();
        const text = await this.context.httpGet(url, this, headers);
        return JSON.parse(text);
    }

    async getApiListPage(page, order, filter) {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", String(this.apiListLimit));
        if (filter && filter.query) params.set("search", filter.query);
        switch (order) {
            case SortOrder.POPULARITY: params.set("sort", "Popular"); params.set("order", "desc"); break;
            case SortOrder.UPDATED: params.set("sort", "last_update"); params.set("order", "desc"); break;
            case SortOrder.ALPHABETICAL: params.set("sort", "name"); params.set("order", "asc"); break;
            case SortOrder.ALPHABETICAL_DESC: params.set("sort", "name"); params.set("order", "desc"); break;
            default: params.set("sort", "Popular"); params.set("order", "desc"); break;
        }
        const url = `https://${this.domain}/api/manga/list?${params.toString()}`;
        const json = await this.apiGetJson(url);
        const items = Array.isArray(json.items) ? json.items : [];
        return items.map(jo => new Manga({
            id: jo.slug,
            url: jo.slug,
            publicUrl: `https://${this.domain}/${jo.slug}`,
            coverUrl: jo.cover || "",
            title: jo.name || jo.slug,
            source: this.source,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        }));
    }

    async getApiDetails(manga) {
        const slug = manga.url;
        const json = await this.apiGetJson(`https://${this.domain}/api/manga/slug/${slug}`);

        const tags = String(json.genres || "").split(",").map(g => g.trim()).filter(Boolean)
            .map(g => ({ key: g.toLowerCase().replace(/\s+/g, "-"), title: g, source: this.source }));

        let state;
        switch (json.m_status) {
            case 1: state = MangaState.FINISHED; break;
            case 2: state = MangaState.ONGOING; break;
            case 3: state = MangaState.PAUSED; break;
        }

        const authors = [json.authors, json.artists].map(x => (x || "").trim()).filter(Boolean);
        const alt = (json.other_name || "").trim();

        return new Manga({
            ...manga,
            title: json.name || manga.title,
            description: json.description || "",
            coverUrl: json.cover || manga.coverUrl,
            altTitles: alt ? [alt] : (manga.altTitles || []),
            authors: authors.length ? authors : (manga.authors || []),
            tags: tags.length ? tags : (manga.tags || []),
            state: state || manga.state,
            chapters: this.parseApiChapters(json),
        });
    }

    parseApiChapters(data) {
        const arr = Array.isArray(data.chapters) ? data.chapters : [];
        const chapters = arr.map(obj => {
            const number = this.apiChapterNumber(obj);
            const ctitle = this.apiChapterTitle(obj);
            const formatted = Number.isInteger(number) ? String(number) : String(number);
            const title = ctitle ? `Chapter ${formatted}: ${ctitle}` : `Chapter ${formatted}`;
            return new MangaChapter({
                id: String(obj.id),
                url: String(obj.id),
                title,
                number,
                volume: 0,
                uploadDate: this.parseIsoDate(obj.last_update || ""),
                source: this.source,
            });
        });
        // oldest-first by number, then date, then id
        chapters.sort((a, b) => (a.number - b.number) || (a.uploadDate - b.uploadDate) || (Number(a.id) - Number(b.id)));
        return chapters;
    }

    apiChapterNumber(obj) {
        const direct = (obj.chapter !== undefined && obj.chapter !== null && obj.chapter !== "") ? Number(obj.chapter)
            : (obj.number !== undefined && obj.number !== null && obj.number !== "") ? Number(obj.number)
            : NaN;
        if (!Number.isNaN(direct)) return direct;
        const raw = [obj.chapter, obj.number, obj.name, obj.title]
            .map(x => (x == null ? "" : String(x)))
            .find(x => x && x.toLowerCase() !== "null") || "";
        const m = raw.match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : 0;
    }

    apiChapterTitle(obj) {
        const candidates = [obj.name, obj.title, obj.chapter_name, obj.chapter_title];
        for (const c of candidates) {
            const t = (c == null ? "" : String(c)).trim();
            if (t && t.toLowerCase() !== "null") return t;
        }
        return null;
    }

    async getApiPages(chapter) {
        const json = await this.apiGetJson(`https://${this.domain}/api/chapter/${chapter.url}`);
        const content = json.content || "";
        if (content) {
            const urls = content.split(/\r\n|\r|\n/).map(s => s.trim()).filter(s => s && s.startsWith("http"));
            if (urls.length) {
                return urls.map(url => new MangaPage({ id: url, url, source: this.source }));
            }
        }
        return [];
    }

    // ============================ DATES ============================

    parseIsoDate(s) {
        if (!s) return 0;
        const t = Date.parse(s);
        return Number.isNaN(t) ? 0 : t;
    }

    /** Parse the HTML-template chapter dates: relative ("4 hours ago"), "today", or absolute. */
    parseChapterDate(date) {
        if (!date) return 0;
        const d = date.toLowerCase();
        if (/\bago\b|\batrás\b/.test(d) || /\d+\s*[hd]\b/.test(d)) {
            return this.parseRelativeDate(d);
        }
        if (d.startsWith("today")) {
            const c = new Date(); c.setHours(0, 0, 0, 0); return c.getTime();
        }
        const t = Date.parse(date);
        return Number.isNaN(t) ? 0 : t;
    }

    parseRelativeDate(date) {
        const m = date.match(/(\d+)/);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        const now = new Date();
        if (/\bsecond/.test(date)) now.setSeconds(now.getSeconds() - n);
        else if (/\bmin|minute|minuto/.test(date)) now.setMinutes(now.getMinutes() - n);
        else if (/\bhour|hora|\bh\b/.test(date)) now.setHours(now.getHours() - n);
        else if (/\bday|día|\bdia|\bd\b/.test(date)) now.setDate(now.getDate() - n);
        else if (/\bweek|semana/.test(date)) now.setDate(now.getDate() - n * 7);
        else if (/\bmonth|\bmes|meses/.test(date)) now.setMonth(now.getMonth() - n);
        else if (/\byear|año/.test(date)) now.setFullYear(now.getFullYear() - n);
        else return 0;
        return now.getTime();
    }
}

/**
 * WELOVEMANGA (welovemanga.one) — same HTML template, but the chapter list and
 * page images are loaded through dedicated PHP AJAX endpoints rather than being
 * present in the detail/reader HTML. The host applies this subclass when the
 * source id is WELOVEMANGA (see index.js wiring); it is also safe to use for any
 * mirror that follows the same `app/manga/controllers` convention.
 *
 * NOTE: at port time welovemanga.one 302-redirects to a survey/parking page, so
 * this path is implemented to spec but could not be verified live.
 */
export class WeLoveMangaParser extends FmreaderParser {
    async getChapters(manga, doc) {
        const input = doc.querySelector("div.cmt input");
        const mid = input ? input.getAttribute("value") : null;
        if (!mid) {
            // Fall back to inline chapter list if the mid input is absent.
            return super.getChapters(manga, doc);
        }
        const html = await this.context.httpGet(
            `https://${this.domain}/app/manga/controllers/cont.Listchapter.php?mid=${mid}`, this);
        const listDoc = this.context.parseHTML(html);
        const anchors = this.queryAll(listDoc, [this.selectChapter, "ul.list-chapters a", "a"]);
        return this.buildChapters(anchors);
    }

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);
        const input = doc.querySelector("#chapter");
        const cid = input ? input.getAttribute("value") : null;
        if (!cid) return this.extractPages(doc);
        const imgHtml = await this.context.httpGet(
            `https://${this.domain}/app/manga/controllers/cont.listImg.php?cid=${cid}`, this);
        const imgDoc = this.context.parseHTML(imgHtml);
        const imgs = Array.from(imgDoc.querySelectorAll("img"));
        const pages = [];
        for (const img of imgs) {
            const url = this.imageSrc(img);
            if (!url) continue;
            pages.push(new MangaPage({ id: url, url, source: this.source }));
        }
        return pages;
    }
}
