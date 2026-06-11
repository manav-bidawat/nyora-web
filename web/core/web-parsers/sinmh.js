import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * SinmhParser — port of Nyora's org.koitharu.nyora.parsers.site.sinmh.SinmhParser
 *
 * Family of Chinese (zh) manga sources built on the "Sinmh" / 思乐漫画 site engine.
 * Concrete sources: YKMH (www.ykmh.net), GUFENGMH (www.gufengmh.com, @Broken in Nyora).
 *
 * Behavior reproduced:
 *  - List/search via path-based URLs (no AJAX): /list/<tag>-<state>/<order>/<page>/  and  /search/?keywords=..&page=..
 *  - Details: description, genre tags, state, chapter list (oldest-first).
 *  - Pages: chapterImages / chapterPath JS array embedded in a <script> on the chapter page,
 *    combined with a CDN host string fetched from /js/config.js.
 *
 * Everything tractable runs inside a fetch + DOMParser browser context — no eval of site JS,
 * no AES decryption. The chapterImages array is plain text inside the page <script>, so we
 * extract it with string parsing exactly like the Kotlin reference does (it also does string
 * substringAfter/Before, not JS execution).
 */
export class SinmhParser extends BaseParser {
    constructor(context, source, domain, pageSize = 36) {
        super(context, source, domain, pageSize);

        // List/search URL fragments (Kotlin: searchUrl / listUrl).
        this.searchUrl = "search/";
        this.listUrl = "list/";

        // Manga-list selectors (Kotlin: doc.select("#contList > li, li.list-comic")).
        this.selectMangaList = ["#contList > li", "li.list-comic"];
        this.selectMangaTitle = ["p > a", "h3 > a"];

        // Details selectors.
        this.selectDesc = "div#intro-all p";
        this.selectGenre = "ul.detail-list li:contains(漫画类型) a";
        this.selectState = "ul.detail-list li:contains(漫画状态) a";
        // :contains() is a jQuery/jsoup extension not supported by browser
        // querySelectorAll, so we keep label keywords for a JS-side fallback.
        this.genreLabel = "漫画类型";
        this.stateLabel = "漫画状态";

        // Chapter list selector (Kotlin: ul#chapter-list-1 li).
        this.selectChapter = ["ul#chapter-list-1 li", "#chapter-list-1 li", "#chapter-list-4 li", ".chapter-body li"];

        // Pages: script holding the embedded image array, and the /js/config.js host source.
        this.selectTestScriptMarker = "chapterImages = ";
        this.configJsPath = "/js/config.js";

        // State keyword sets (Kotlin: ongoing / finished).
        this.ongoing = new Set(["连载中"]);
        this.finished = new Set(["已完结"]);
    }

    // --- helpers (mirrors madara.js conventions) ---

    queryAll(doc, selectors) {
        for (const selector of (selectors || []).filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Sinmh overrides occasionally use selectors a given DOM rejects;
                // fall through to the next known shape.
            }
        }
        return [];
    }

    querySelectorAny(el, selectors) {
        for (const selector of (selectors || []).filter(Boolean)) {
            try {
                const found = el.querySelector(selector);
                if (found) return found;
            } catch {
                // ignore unsupported selector, try next
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-src") || img.getAttribute("data-original") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Reproduce jsoup's ":contains(label)" for browser DOM: find the li whose text
    // includes `label`, then return its <a> elements.
    findLabeledLinks(doc, containerSelector, label) {
        const links = [];
        let lis = [];
        try {
            lis = Array.from(doc.querySelectorAll(containerSelector));
        } catch {
            lis = [];
        }
        for (const li of lis) {
            if ((li.textContent || "").includes(label)) {
                links.push(...Array.from(li.querySelectorAll("a")));
            }
        }
        return links;
    }

    tagFromHref(href) {
        // Kotlin: a.attr("href").removeSuffix('/').substringAfterLast('/')
        return (href || "").replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
    }

    // --- list / search ---

    async getListPage(page, order, filter) {
        filter = filter || {};
        const tags = filter.tags ? Array.from(filter.tags) : [];
        const states = filter.states ? Array.from(filter.states) : [];

        let url = `https://${this.domain}/`;
        if (filter.query) {
            url += `${this.searchUrl}?keywords=${encodeURIComponent(filter.query)}&page=${page}`;
        } else {
            url += this.listUrl;

            // single tag key
            if (tags.length) {
                url += tags[0].key;
            }
            // single state suffix
            if (states.length) {
                const st = states[0];
                if (st === MangaState.ONGOING) url += "-lianzai";
                else if (st === MangaState.FINISHED) url += "-wanjie";
            }
            if (tags.length && states.length) {
                url += "/";
            }

            switch (order) {
                case SortOrder.POPULARITY: url += "click/"; break;
                case SortOrder.UPDATED: url += "update/"; break;
                default: url += "/"; break;
            }
            url += `${page}/`;
        }

        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);

        const elements = this.queryAll(doc, this.selectMangaList);
        const list = [];
        for (const div of elements) {
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);

            const titleEl = this.querySelectorAny(div, this.selectMangaTitle);
            const img = div.querySelector("img");
            const votes = div.querySelector("span.total_votes");
            let rating = 0;
            if (votes) {
                const v = parseFloat((votes.textContent || "").trim());
                if (!isNaN(v)) rating = v / 5;
            }

            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: titleEl ? titleEl.textContent.trim() : (a.getAttribute("title") || a.textContent || "").trim(),
                rating,
                state: null,
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

        const chapters = this.getChapters(doc);

        const descEl = this.querySelectorAny(doc, [this.selectDesc, "div#intro-all", ".intro-total", ".comic-description"]);
        const description = descEl ? descEl.innerHTML : (manga.description || "");

        // State: try the jsoup-style label li, fall back to scanning detail-list.
        let state = manga.state || null;
        const stateLinks = this.findLabeledLinks(doc, "ul.detail-list li", this.stateLabel);
        const stateText = stateLinks.length ? (stateLinks[0].textContent || "").trim() : "";
        if (stateText) {
            if (this.ongoing.has(stateText)) state = MangaState.ONGOING;
            else if (this.finished.has(stateText)) state = MangaState.FINISHED;
        }

        // Genre tags: li:contains(漫画类型) a
        const genreLinks = this.findLabeledLinks(doc, "ul.detail-list li", this.genreLabel);
        const tags = genreLinks.map((a) => {
            const key = this.tagFromHref(a.getAttribute("href"));
            return { key, title: (a.textContent || "").trim(), source: this.source };
        }).filter((t) => t.key);

        const title = doc.querySelector("h1")?.textContent?.trim() || manga.title;
        const cover = this.imageSrc(doc.querySelector(".banner_detail_form .cover img, .de-info__cover img, .comic-cover img")) || manga.coverUrl || "";

        return new Manga({
            ...manga,
            title,
            coverUrl: cover || manga.coverUrl,
            largeCoverUrl: cover || manga.largeCoverUrl || manga.coverUrl,
            description,
            state,
            tags: tags.length ? tags : manga.tags,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            source: this.source,
            chapters,
        });
    }

    // Kotlin getChapters: list is already oldest-first in source markup; number = i+1.
    getChapters(doc) {
        const elements = this.queryAll(doc, this.selectChapter);
        return elements.map((li, i) => {
            const a = li.querySelector("a");
            if (!a) return null;
            const href = a.getAttribute("href");
            if (!href) return null;
            const relHref = this.toRelativeUrl(href);
            const title = (a.textContent || "").trim() || null;
            return new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: i + 1,
                volume: 0,
                branch: null,
                uploadDate: 0,
                scanlator: null,
                source: this.source,
            });
        }).filter((c) => c && c.url && !c.url.includes("#"));
    }

    // --- pages ---

    async getCdnHost() {
        // Kotlin: GET /js/config.js, raw text, extract domain":["...host..."]}
        try {
            const raw = await this.context.httpGet(this.toAbsoluteUrl(this.configJsPath), this);
            const marker = 'domain":["';
            const start = raw.indexOf(marker);
            if (start >= 0) {
                const rest = raw.slice(start + marker.length);
                const end = rest.indexOf('"]}');
                const host = (end >= 0 ? rest.slice(0, end) : rest).replace(/http:/g, "https:");
                if (host) return host;
            }
        } catch {
            // config.js unreachable — fall back to the site origin below.
        }
        return `https://${this.domain}`;
    }

    async getPages(chapter) {
        const host = await this.getCdnHost();

        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);

        // Locate the script containing `chapterImages = [...]`. We match against the
        // raw HTML so we don't depend on a particular <script> selector survival.
        const marker = this.selectTestScriptMarker; // "chapterImages = "
        const markerIdx = html.indexOf(marker);
        if (markerIdx < 0) {
            // No embedded image array in the chapter page — nothing tractable to extract.
            return [];
        }

        // chapterImages = [ ... ];var chapterPath
        const afterImages = html.slice(markerIdx + marker.length);
        const arrOpen = afterImages.indexOf("[");
        let imagesPart = "";
        if (arrOpen >= 0) {
            const arrTail = afterImages.slice(arrOpen + 1);
            const arrClose = arrTail.indexOf("];");
            imagesPart = arrClose >= 0 ? arrTail.slice(0, arrClose) : arrTail.split("\n")[0];
        }
        const images = imagesPart
            .replace(/"/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length);

        // chapterPath = "...";var
        let path = "";
        const pathMarker = 'chapterPath = "';
        const pathIdx = html.indexOf(pathMarker);
        if (pathIdx >= 0) {
            const afterPath = html.slice(pathIdx + pathMarker.length);
            const pathEnd = afterPath.indexOf('"');
            path = pathEnd >= 0 ? afterPath.slice(0, pathEnd) : "";
        }

        const pages = [];
        for (const it of images) {
            let imageUrl;
            if (it.startsWith("https:\\/\\/")) {
                imageUrl = it.replace(/\\/g, "");
            } else if (it.startsWith("http:\\/\\/")) {
                imageUrl = it.replace(/\\/g, "").replace("http:", "https:");
            } else if (it.startsWith("\\/")) {
                imageUrl = host + it.replace(/\\/g, "");
            } else if (it.startsWith("/")) {
                imageUrl = `${host}${it}`;
            } else {
                imageUrl = `${host}/${path}${it}`;
            }
            pages.push(new MangaPage({
                id: imageUrl,
                url: imageUrl,
                preview: null,
                source: this.source,
            }));
        }
        return pages;
    }
}
