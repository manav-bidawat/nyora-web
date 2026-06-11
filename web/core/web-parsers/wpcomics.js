import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * WpComicsParser — port of Nyora's WpComicsParser family (key "wpcomics").
 *
 * Covers the 8 concrete VI/EN/JA sources (NetTruyenHE, NetTruyenVie, NewTruyen,
 * NetTruyen, DocTruyen3Q, NhatTruyenVN, TopTruyen, MangaRaw / XoxoComics-style).
 * Most sources share the classic WpComics "tim-truyen" markup. A few have their
 * own list/chapter shapes (DocTruyen3Q/TopTruyen "item-manga", NetTruyen/Nhat ASMX
 * JSON ChapterList API, NewTruyen storyID API, XoxoComics paged chapters). Rather
 * than encode every subclass as a separate file, the per-source descriptor only
 * carries simple field overrides (listUrl, datePattern) via Object.assign, so this
 * single class detects the relevant variant from `domain`/`source.id` at runtime
 * and uses queryAll(...) selector fallbacks so minor markup drift doesn't break us.
 *
 * Everything here is achievable with fetch + DOMParser; there is no AES/JS-VM page
 * decryption in this family. See report for live-reachability caveats.
 */
export class WpComicsParser extends BaseParser {
    constructor(context, source, domain, pageSize = 48) {
        super(context, source, domain, pageSize);

        // Tunable selectors / URL fragments (overridable per-source via Object.assign).
        this.listUrl = "/tim-truyen";
        this.datePattern = "dd/MM/yy";

        this.coverDiv = "div.image a img";
        this.selectDesc = "div.detail-content p";
        this.selectState = "div.col-info li.status p:not(.name)";
        this.selectAut = "div.col-info li.author p:not(.name), li.author p.col-xs-8";
        this.selectTag = "div.col-info li.kind p:not(.name) a, li.kind p.col-xs-8 a";
        this.selectDate = "div.col-xs-4";
        this.selectChapter = "div.list-chapter li.row:not(.heading)";
        this.selectPage = "div.page-chapter > img, li.blocks-gallery-item img, div.page-chapter img";

        // State vocabulary (covers VI / EN / JA wording across the family).
        this.ongoing = new Set([
            "đang tiến hành", "đang cập nhật", "ongoing", "updating", "連載中",
        ]);
        this.finished = new Set([
            "hoàn thành", "đã hoàn thành", "complete", "completed", "完結済み",
        ]);

        // Ad-image fragments to strip from page lists (DocTruyen3Q / TopTruyen).
        this.adFragments = [
            "sp1.jpg", "sp2.jpg", "3q_fake", "3qui5.jpg", "3qui6.jpg", "3qui8.jpg",
            "3qui9.jpg", "3qui10.jpg", "3qui12.jpg", "3qui13.jpg", "3q_top", "3q282.jpg",
            "3qui5_banner.jpg", "dt3qui8.jpg", "toptruyentv.jpg", "follow.png",
            "image_default.png", "toptruyentv5.jpg", "toptruyentv6.jpg", "toptruyentv7.jpg",
            "toptruyentv8.jpg", "toptruyentv9.jpg", "img_001_1743221470.png",
        ];
    }

    // ---- helpers (mirrors madara.js conventions) -------------------------

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to a simpler selector when the DOM rejects one.
            }
        }
        return [];
    }

    queryFirst(root, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const el = root.querySelector(selector);
                if (el) return el;
            } catch {
                // try next
            }
        }
        return null;
    }

    /**
     * WpComics lazy-loads covers; the real URL can live in any attribute that
     * parses as an http(s) URL (data-original / data-src / src). `src` has the
     * lowest priority (mirrors Kotlin's findImageUrl()).
     */
    imageSrc(img) {
        if (!img) return "";
        const candidates = [
            img.getAttribute("data-original"),
            img.getAttribute("data-src"),
            img.getAttribute("data-lazy-src"),
            img.getAttribute("src"),
        ];
        for (const c of candidates) {
            if (!c) continue;
            if (c.startsWith("data:") || c.startsWith("blob:")) continue;
            return this.toAbsoluteUrl(c);
        }
        return "";
    }

    contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    isItemMangaSite() {
        // DocTruyen3Q / TopTruyen use the "item-manga" listing markup.
        const id = (this.source && this.source.id) || "";
        return id === "DOCTRUYEN3Q" || id === "TOPTRUYEN" ||
            /doctruyen3q|toptruyen/i.test(this.domain);
    }

    isMangaRaw() {
        // mangaraw.best has been rebuilt as a modern Laravel/Livewire app that no
        // longer uses any WpComics markup. It uses /raw/<slug> URLs, "manga-vertical"
        // cards and a different (but still server-rendered) reader, so it needs its
        // own list/details/pages branch.
        const id = (this.source && this.source.id) || "";
        return id === "MANGARAW" || /mangaraw\.best/i.test(this.domain);
    }

    parseRating(doc) {
        const input = this.queryFirst(doc, ["div.star input", "div.star input[value]"]);
        const v = input && parseFloat(input.getAttribute("value"));
        return v && !Number.isNaN(v) ? v / 5 : 0;
    }

    /** Relative VI dates ("3 giờ trước") and absolute dd-MM-yyyy / dd/MM/yy. */
    parseChapterDate(text) {
        if (!text) return 0;
        const d = text.toLowerCase().trim();
        const now = Date.now();
        const num = (() => {
            const m = d.match(/(\d+)/);
            return m ? parseInt(m[1], 10) : 0;
        })();

        if (/giây|second/.test(d) && /trước|ago/.test(d)) return now - num * 1000;
        if (/phút|min/.test(d) && /trước|ago/.test(d)) return now - num * 60 * 1000;
        if (/(giờ|hour|\bh\b)/.test(d) && /trước|ago/.test(d)) return now - num * 3600 * 1000;
        if (/ngày|day/.test(d) && /trước|ago/.test(d)) return now - num * 86400 * 1000;
        if (/tuần|week/.test(d) && /trước|ago/.test(d)) return now - num * 7 * 86400 * 1000;
        if (/tháng|month/.test(d) && /trước|ago/.test(d)) return now - num * 30 * 86400 * 1000;
        if (/năm|year/.test(d) && /trước|ago/.test(d)) return now - num * 365 * 86400 * 1000;

        // Absolute dd-MM-yyyy or dd/MM/yyyy or dd/MM/yy.
        const m = d.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
        if (m) {
            let [, dd, mm, yy] = m;
            let year = parseInt(yy, 10);
            if (year < 100) year += 2000;
            const t = Date.UTC(year, parseInt(mm, 10) - 1, parseInt(dd, 10));
            if (!Number.isNaN(t)) return t;
        }
        return 0;
    }

    // ---- list ------------------------------------------------------------

    buildListUrl(page, order, filter) {
        const id = (this.source && this.source.id) || "";
        const q = filter && filter.query ? encodeURIComponent(filter.query) : "";

        // NetTruyenHE: advanced filter list + dedicated /search/<page>/?keyword path.
        if (id === "NETTRUYENHE") {
            if (q) return `https://${this.domain}/search/${page}/?keyword=${q}`;
            const tag = filter && filter.tags && filter.tags[0];
            let sort = "latest-updated";
            switch (order) {
                case SortOrder.POPULARITY: sort = "views"; break;
                case SortOrder.NEWEST: sort = "new"; break;
                case SortOrder.RATING: sort = "score"; break;
                case SortOrder.ALPHABETICAL: sort = "az"; break;
                case SortOrder.ALPHABETICAL_DESC: sort = "za"; break;
                default: sort = "latest-updated";
            }
            return `https://${this.domain}${this.listUrl}/${page}/?genres=${tag ? tag.key : ""}` +
                `&notGenres=&sex=All&chapter_count=0&sort=${sort}`;
        }

        // XoxoComics-style (en): /comic-list, distinct sort path segments.
        if (id === "XOXOCOMICS" || /xoxocomic/i.test(this.domain)) {
            if (q) return `https://${this.domain}/search-comic?keyword=${q}&page=${page}`;
            let seg = "/comic-update";
            switch (order) {
                case SortOrder.POPULARITY: seg = "/popular-comic"; break;
                case SortOrder.NEWEST: seg = "/new-comic"; break;
                case SortOrder.ALPHABETICAL: seg = this.listUrl; break;
                default: seg = "/comic-update";
            }
            return `https://${this.domain}${seg}?page=${page}`;
        }

        // DocTruyen3Q / TopTruyen: /tim-truyen with sort=1/2 + optional tag path.
        if (this.isItemMangaSite()) {
            let url = `https://${this.domain}/tim-truyen`;
            const tag = filter && filter.tags && filter.tags[0];
            if (tag) url += `/${tag.key}`;
            const params = [];
            if (order === SortOrder.UPDATED) params.push("sort=1");
            else if (order === SortOrder.POPULARITY) params.push("sort=2");
            if (q) params.push(`keyword=${q}`);
            if (page > 1) params.push(`page=${page}`);
            if (params.length) url += `?${params.join("&")}`;
            return url;
        }

        // MangaRaw (ja): list lives under /search/manga; search via ?keyword.
        if (this.isMangaRaw()) {
            // Live mangaraw.best no longer serves the WpComics /search/manga list
            // page; the card grid lives on the homepage and on /search?keyword=.
            if (q) return `https://${this.domain}/search?keyword=${q}&page=${page}`;
            return `https://${this.domain}/?page=${page}`;
        }

        // Default WpComics template (NetTruyen, NetTruyenVie, NewTruyen, NhatTruyenVN, ...).
        if (q) {
            return `https://${this.domain}${this.listUrl}?keyword=${q}&page=${page}`;
        }
        let url = `https://${this.domain}${this.listUrl}`;
        const tag = filter && filter.tags && filter.tags[0];
        if (tag) url += `/${tag.key}`;
        let sort = 0;
        switch (order) {
            case SortOrder.UPDATED: sort = 0; break;
            case SortOrder.POPULARITY: sort = 10; break;
            case SortOrder.NEWEST: sort = 15; break;
            case SortOrder.RATING: sort = 20; break;
            default: sort = 0;
        }
        url += `?sort=${sort}`;
        const state = filter && filter.states && filter.states[0];
        if (state) {
            url += `&status=${state === MangaState.ONGOING ? "1" : state === MangaState.FINISHED ? "2" : "-1"}`;
        }
        url += `&page=${page}`;
        return url;
    }

    async getListPage(page, order, filter = {}) {
        const url = this.buildListUrl(page, order, filter);
        let html;
        try {
            html = await this.context.httpGet(url, this);
        } catch {
            return [];
        }
        const doc = this.context.parseHTML(html);
        if (this.isMangaRaw()) return this.parseMangaRawList(doc);
        return this.parseMangaList(doc);
    }

    // mangaraw.best: cards are "div.manga-vertical" with /raw/<slug> links and
    // "div.cover-frame img" covers (modern Tailwind markup, not WpComics).
    parseMangaRawList(doc) {
        const list = [];
        const seen = new Set();
        const cards = this.queryAll(doc, ["div.manga-vertical", "div.cover-frame"]);
        for (const card of cards) {
            const a = this.queryFirst(card, ['a[href^="/raw/"]', "a"]);
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href") || "");
            // Series URL is /raw/<slug> exactly (chapter links have a 2nd segment).
            const m = href.match(/^\/raw\/([^/]+)\/?$/);
            if (!m) continue;
            if (seen.has(href)) continue;
            const img = this.queryFirst(card, ["div.cover-frame img", "img.cover", "img"]);
            const title = (img && img.getAttribute("alt")) ||
                (this.queryFirst(card, [".latest-chapter a", "a.text-white"])?.textContent || "").trim() ||
                a.textContent.trim();
            if (!title) continue;
            seen.add(href);
            list.push(new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(img),
                title,
                source: this.source,
                contentRating: this.contentRating(),
            }));
        }
        return list;
    }

    parseMangaList(doc) {
        // Variant A: DocTruyen3Q / TopTruyen "item-manga"; Variant B: classic
        // WpComics "items > item"; Variant C: XoxoComics article/list rows.
        let items = this.queryAll(doc, [
            "div.items div.item",
            "div.item-manga",
            "div.items article.item",
            "div.row div.item",
            "li.row",
        ]);
        const list = [];
        const seen = new Set();

        for (const item of items) {
            const a = this.queryFirst(item, [
                "div.image > a",
                "div.image-item a",
                "figure figcaption h3 a",
                "figcaption h3 a",
                "h3 a",
                "a",
            ]);
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            if (!relHref || relHref === "/" || relHref.includes("#")) continue;
            if (seen.has(relHref)) continue;

            const titleEl = this.queryFirst(item, [
                "div.box_tootip div.title",
                "h3 a",
                "h3",
                ".title",
            ]);
            const title = (titleEl ? titleEl.textContent : (a.getAttribute("title") || a.textContent) || "").trim();
            if (!title) continue;

            const img = this.queryFirst(item, [
                this.coverDiv,
                "div.image-item img",
                "div.image img",
                "img",
            ]);

            // Optional tooltip metadata (classic WpComics markup).
            const tip = item.querySelector("div.box_tootip");
            let state;
            let author;
            if (tip) {
                const stateP = this.tipField(tip, "Tình trạng");
                if (stateP) {
                    const v = stateP.toLowerCase();
                    if (this.ongoing.has(v)) state = MangaState.ONGOING;
                    else if (this.finished.has(v)) state = MangaState.FINISHED;
                }
                author = this.tipField(tip, "Tác giả");
            }

            seen.add(relHref);
            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title,
                authors: author ? [author] : [],
                state,
                source: this.source,
                contentRating: this.contentRating(),
            }));
        }
        return list;
    }

    /** Read "<label>: value" out of a box_tootip paragraph (own text). */
    tipField(tip, label) {
        const ps = Array.from(tip.querySelectorAll("div.message_main > p, p"));
        for (const p of ps) {
            if ((p.textContent || "").includes(label)) {
                // ownText: strip the bolded label span text.
                const labelEl = p.querySelector("b, strong, span.name");
                let txt = p.textContent || "";
                if (labelEl) txt = txt.replace(labelEl.textContent || "", "");
                txt = txt.replace(label, "").replace(/^[:\s]+/, "").trim();
                if (txt) return txt;
            }
        }
        return null;
    }

    // ---- details + chapters ---------------------------------------------

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        if (this.isMangaRaw()) return this.getMangaRawDetails(manga, doc);

        const descEl = this.queryFirst(doc, [
            "div.detail-content > div",
            "div.detail-content p",
            "div.summary-content p.detail-summary",
            "div.summary-content",
            this.selectDesc,
        ]);
        const description = descEl ? descEl.innerHTML.trim() : (manga.description || "");

        const altEl = this.queryFirst(doc, [
            "h2.other-name",
            "li.name-other.row p.detail-info",
        ]);
        const altTitle = altEl ? (altEl.textContent || "").trim() : "";

        const authorEl = this.queryFirst(doc, [
            "li.author.row p.detail-info",
            ...this.selectAut.split(","),
        ]);
        let author = authorEl ? (authorEl.textContent || "").trim() : "";
        if (author === "Đang cập nhật") author = "";

        const stateEl = this.queryFirst(doc, [
            "li.status.row p.detail-info span.label",
            ...this.selectState.split(","),
        ]);
        let state;
        if (stateEl) {
            const v = (stateEl.textContent || "").toLowerCase().trim();
            if (this.ongoing.has(v)) state = MangaState.ONGOING;
            else if (this.finished.has(v)) state = MangaState.FINISHED;
        }

        const tags = this.parseTags(doc);
        const chapters = await this.loadChapters(manga, doc, html, fullUrl);

        return new Manga({
            ...manga,
            title: this.queryFirst(doc, ["h1.title-detail", "h1"])?.textContent?.trim() || manga.title,
            altTitles: altTitle ? [altTitle] : (manga.altTitles || []),
            description,
            authors: author ? [author] : (manga.authors || []),
            state: state || manga.state,
            tags: tags.length ? tags : (manga.tags || []),
            rating: this.parseRating(doc) || manga.rating || 0,
            coverUrl: manga.coverUrl || this.imageSrc(this.queryFirst(doc, ["div.col-image img", "div.detail-info img", "img"])),
            source: this.source,
            contentRating: this.contentRating(),
            chapters,
        });
    }

    parseTags(doc) {
        const els = this.queryAll(doc, [
            "li.kind p.col-xs-8 a",
            "li.category.row p.detail-info a[href*=tim-truyen]",
            "p.col-xs-12 a.tr-theloai",
            ...this.selectTag.split(","),
        ]);
        const tags = [];
        const seen = new Set();
        for (const a of els) {
            const title = (a.textContent || "").trim();
            const href = a.getAttribute("href") || "";
            const key = href.replace(/\/$/, "").split("/").pop();
            if (!title || !key || seen.has(key)) continue;
            seen.add(key);
            tags.push({ title, key });
        }
        return tags;
    }

    async loadChapters(manga, doc, html, fullUrl) {
        const id = (this.source && this.source.id) || "";
        const slug = (this.toRelativeUrl(manga.url) || "").replace(/\/$/, "").split("/").pop();

        // NetTruyen / NetTruyenVie / NhatTruyenVN: ASMX JSON ChapterList API.
        if (id === "NETTRUYEN" || id === "NETTRUYENVIE" || id === "NHATTRUYENVN") {
            const apiChapters = await this.fetchAsmxChapters(id, slug);
            if (apiChapters && apiChapters.length) return apiChapters;
        }

        // NewTruyen: storyID input -> /Story/ListChapterByStoryID.
        if (id === "NEWTRUYEN") {
            const storyId = this.queryFirst(doc, ["input#storyID"])?.getAttribute("value");
            if (storyId) {
                const apiChapters = await this.fetchStoryIdChapters(storyId);
                if (apiChapters && apiChapters.length) return apiChapters;
            }
        }

        // XoxoComics: paginated chapter pages (?page=N) until empty.
        if (id === "XOXOCOMICS" || /xoxocomic/i.test(this.domain)) {
            const paged = await this.fetchXoxoChapters(fullUrl);
            if (paged && paged.length) return paged;
        }

        // Default: chapters already in the detail HTML.
        return this.parseChaptersFromDoc(doc);
    }

    async fetchAsmxChapters(id, slug) {
        try {
            let apiUrl;
            if (id === "NETTRUYEN") {
                // NetTruyen: slug = name without trailing "-<id>", comicId = that id.
                const raw = slug || "";
                const realSlug = raw.replace(/-\d+$/, "");
                const comicId = (raw.match(/-(\d+)$/) || [, raw.split("-").pop()])[1];
                apiUrl = `https://${this.domain}/Comic/Services/ComicService.asmx/ChapterList?slug=${realSlug}&comicId=${comicId}`;
            } else {
                apiUrl = `https://${this.domain}/Comic/Services/ComicService.asmx/ChapterList?slug=${slug}`;
            }
            const text = await this.context.httpGet(apiUrl, this);
            const json = JSON.parse(text);
            const data = json.data || [];
            const n = data.length;
            const chapters = [];
            for (let i = 0; i < n; i++) {
                const jo = data[n - 1 - i];
                const chapterSlug = jo.chapter_slug;
                let chapterUrl;
                if (id === "NETTRUYEN") {
                    const realSlug = (slug || "").replace(/-\d+$/, "");
                    chapterUrl = `/truyen-tranh/${realSlug}/${chapterSlug}/${jo.chapter_id}`;
                } else {
                    chapterUrl = `/truyen-tranh/${slug}/${chapterSlug}`;
                }
                const num = parseFloat(jo.chapter_num) || (i + 1);
                chapters.push(new MangaChapter({
                    id: chapterUrl,
                    url: chapterUrl,
                    title: jo.chapter_name || `Chapter ${chapterSlug}`,
                    number: num,
                    uploadDate: this.parseChapterDate(jo.updated_at),
                    source: this.source,
                }));
            }
            return chapters;
        } catch {
            return null;
        }
    }

    async fetchStoryIdChapters(storyId) {
        try {
            const url = `https://${this.domain}/Story/ListChapterByStoryID?storyID=${storyId}`;
            const html = await this.context.httpGet(url, this);
            const doc = this.context.parseHTML(html);
            const lis = this.queryAll(doc, ["li.row", "div.list-chapter li.row"]);
            const out = [];
            for (const li of lis) {
                const a = this.queryFirst(li, ["div.col-xs-5.chapter a", "div.chapter a", "a"]);
                if (!a) continue;
                const href = this.toRelativeUrl(a.getAttribute("href"));
                if (!href) continue;
                const dateText = this.queryFirst(li, ["div.col-xs-4.text-center.small", "div.col-xs-4"])?.textContent;
                out.push({ href, title: (a.textContent || "").trim(), dateText });
            }
            out.reverse();
            return out.map((c, i) => new MangaChapter({
                id: c.href,
                url: c.href,
                title: c.title,
                number: i + 1,
                uploadDate: this.parseChapterDate(c.dateText),
                source: this.source,
            }));
        } catch {
            return null;
        }
    }

    async fetchXoxoChapters(baseUrl) {
        const collected = [];
        for (let page = 1; page <= 50; page++) {
            let html;
            try {
                html = await this.context.httpGet(`${baseUrl}?page=${page}`, this);
            } catch {
                break;
            }
            const doc = this.context.parseHTML(html);
            const lis = this.queryAll(doc, ["#nt_listchapter nav ul li:not(.heading)", "#nt_listchapter li:not(.heading)"]);
            if (!lis.length) break;
            for (const li of lis) {
                const a = this.queryFirst(li, ["a"]);
                if (!a) continue;
                const href = this.toRelativeUrl(a.getAttribute("href"));
                if (!href) continue;
                const dateText = this.queryFirst(li, ["div.col-xs-3"])?.textContent;
                collected.push({ href, title: (a.textContent || "").trim(), dateText });
            }
        }
        collected.reverse();
        return collected.map((c, i) => new MangaChapter({
            id: c.href,
            url: c.href,
            title: c.title,
            number: i + 1,
            uploadDate: this.parseChapterDate(c.dateText),
            source: this.source,
        }));
    }

    // mangaraw.best details: title h1, chapters are <a href="/raw/<slug>/<chap>">
    // wrapping an <li> whose span.text-ellipsis holds the chapter name and
    // span.timeago a relative (Japanese) date. Genre tags via /genre/<key> links.
    getMangaRawDetails(manga, doc) {
        const slug = (this.toRelativeUrl(manga.url) || "").replace(/\/$/, "").split("/").pop();
        const seriesPrefix = `/raw/${slug}/`;

        const title = this.queryFirst(doc, ["h1", "h1.text-2xl"])?.textContent?.trim() || manga.title;

        const tags = [];
        const seenTag = new Set();
        for (const a of this.queryAll(doc, ['a[href*="/genre/"]'])) {
            const key = (a.getAttribute("href") || "").replace(/\/$/, "").split("/").pop();
            const tTitle = (a.textContent || "").trim();
            if (!key || !tTitle || seenTag.has(key)) continue;
            seenTag.add(key);
            tags.push({ title: tTitle, key });
        }

        const cover = this.imageSrc(this.queryFirst(doc, ['img.cover', 'div.cover-frame img', 'img[alt]']));

        const anchors = this.queryAll(doc, [`a[href^="${seriesPrefix}"]`]);
        const rows = [];
        const seen = new Set();
        for (const a of anchors) {
            const href = this.toRelativeUrl(a.getAttribute("href") || "");
            if (!href.startsWith(seriesPrefix)) continue;
            // skip non-chapter slugs and dupes (first/last-chapter buttons share urls)
            if (seen.has(href)) continue;
            const li = a.querySelector("li");
            // The chapter list rows wrap an <li>; the nav buttons do not have the
            // text-ellipsis chapter span, so require it to avoid grabbing buttons.
            const nameEl = (li || a).querySelector("span.text-ellipsis");
            if (!nameEl) continue;
            seen.add(href);
            const dateText = (li || a).querySelector("span.timeago")?.textContent;
            rows.push({ href, title: (nameEl.textContent || "").trim(), dateText });
        }
        // Listed newest-first; reverse to oldest-first.
        rows.reverse();
        const chapters = rows.map((c, i) => {
            const numMatch = c.title.match(/(\d+(?:\.\d+)?)/);
            return new MangaChapter({
                id: c.href,
                url: c.href,
                title: c.title || `Chapter ${i + 1}`,
                number: numMatch ? parseFloat(numMatch[1]) : i + 1,
                uploadDate: this.parseChapterDate(c.dateText),
                source: this.source,
            });
        });

        return new Manga({
            ...manga,
            title,
            coverUrl: manga.coverUrl || cover,
            tags: tags.length ? tags : (manga.tags || []),
            source: this.source,
            contentRating: this.contentRating(),
            chapters,
        });
    }

    parseChaptersFromDoc(doc) {
        // item-manga sites use a.chapter with data-chapter; classic uses list-chapter li.row.
        let lis = this.queryAll(doc, [
            this.selectChapter,
            "div.list-chapter li.row:not(.heading)",
            "div.list_chapter div.row:not(.heading)",
            "li.row:not(.heading)",
            "ul.list-chapter li",
            "div.list-chapter li",
        ]).filter((li) => {
            const style = li.getAttribute && li.getAttribute("style");
            return !(style && /display:\s*none/.test(style));
        });

        const out = [];
        for (const li of lis) {
            const a = this.queryFirst(li, ["a.chapter", "div.chapter a", "a"]);
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href || href.includes("#")) continue;
            const dateText = this.queryFirst(li, [
                "div.style-chap",
                this.selectDate,
                "div.col-xs-4",
                "div.col-xs-3",
            ])?.textContent;
            const dataNum = a.getAttribute && a.getAttribute("data-chapter");
            out.push({
                href,
                title: (a.textContent || "").trim(),
                dateText,
                dataNum: dataNum ? parseFloat(dataNum) : null,
            });
        }
        // Detail HTML lists newest-first; reverse to oldest-first.
        out.reverse();
        return out.map((c, i) => new MangaChapter({
            id: c.href,
            url: c.href,
            title: c.title || `Chapter ${i + 1}`,
            number: c.dataNum != null && !Number.isNaN(c.dataNum) ? c.dataNum : i + 1,
            uploadDate: this.parseChapterDate(c.dateText),
            source: this.source,
        }));
    }

    // ---- pages -----------------------------------------------------------

    async getPages(chapter) {
        let fullUrl = this.toAbsoluteUrl(chapter.url);
        // XoxoComics serves the whole chapter under /all.
        if ((this.source && this.source.id) === "XOXOCOMICS" || /xoxocomic/i.test(this.domain)) {
            fullUrl = fullUrl.replace(/\/$/, "") + "/all";
        }
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        if (this.isMangaRaw()) return this.getMangaRawPages(html);

        const imgs = this.queryAll(doc, [
            this.selectPage,
            "div.page-chapter > img",
            "div.page-chapter img",
            "li.blocks-gallery-item img",
            "div.reading-detail img",
            "div.reading img",
            "img[data-original]",
        ]);

        const pages = [];
        const seen = new Set();
        for (const img of imgs) {
            let url = this.imageSrc(img);
            if (!url) continue;
            url = url.replace(/[\[\]]/g, "");
            if (this.adFragments.some((f) => url.includes(f))) continue;
            if (seen.has(url)) continue;
            seen.add(url);
            pages.push(new MangaPage({
                id: url,
                url,
                source: this.source,
            }));
        }
        return pages;
    }

    // mangaraw.best reader serves page images directly as <img src> from its CDN
    // host (e.g. rbest.mgcdnxyz.cfd/<cover-uuid>/<chapter-uuid>/<n>.jpg). Extract
    // them from the HTML and sort numerically by trailing page number so order is
    // correct regardless of DOM ordering.
    getMangaRawPages(html) {
        const found = new Map(); // url -> page number
        const re = /https?:\/\/[^"'\s)]*\/(\d+)\.(?:jpe?g|png|webp)/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const url = m[0];
            // Skip obvious non-page assets (avatars, covers, logos, ui).
            if (/\/(avatars?|default|covers?|logo|credit|images\/pets)\//i.test(url)) continue;
            if (!found.has(url)) found.set(url, parseInt(m[1], 10));
        }
        const entries = Array.from(found.entries()).sort((a, b) => a[1] - b[1]);
        return entries.map(([url]) => new MangaPage({
            id: url,
            url,
            source: this.source,
        }));
    }
}
