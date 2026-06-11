import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * AnimeBootstrapParser — port of Nyora's AnimeBootstrapParser family.
 *
 * Concrete sources (key "animebootstrap"):
 *   - KOMIKZOID  (komikzoid.id, id)
 *   - NEUMANGA   (neumanga.id, id)
 *   - SEKTEKOMIK (sektekomik.id, id)
 *   (PapScan/fr is @Broken upstream and not shipped here.)
 *
 * These are "AnimeBootstrap" themed WordPress/Laravel manga sites. List markup
 * uses Bootstrap `product__item` cards with `data-setbg` cover backgrounds;
 * details pages use `anime__details__*` blocks; the reader exposes pages either
 * as a `var pages = [...]` JSON array inside a `<script>` (page_image keys) or as
 * `<img onerror="this.onerror=null;this.src=`<url>`;">` lazy fallbacks.
 *
 * Every tunable selector / URL fragment is an instance field so a per-source
 * `overrides` object can patch it via Object.assign (as the smoke harness does).
 */
export class AnimeBootstrapParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // List / search
        this.listUrl = "/manga";
        this.datePattern = "dd MMM. yyyy";

        // List card selectors (primary template shape).
        this.selectMangaList = "div.col-6 div.product__item";
        this.selectMangaListLink = "a";
        this.selectMangaListPic = "div.product__item__pic";
        this.selectMangaListTitle = "div.product__item__text";
        this.coverAttr = "data-setbg";

        // Details selectors
        this.selectDesc = "div.anime__details__text p";
        this.selectState = "div.anime__details__widget li:contains(Ongoing)";
        this.selectTag = "div.anime__details__widget li:contains(Categorie) a";

        // Chapters
        this.selectChapter = "div.anime__details__episodes a";

        // Pages
        this.selectPage = "div.read-img img";
    }

    // Try a list of selectors, returning the first non-empty match. Mirrors the
    // madara.js/mangareader.js fallback helper so minor markup drift is tolerated.
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some overrides use selector syntax a given DOM rejects (e.g. the
                // jsoup-only `:contains()` pseudo); fall through to the next.
            }
        }
        return [];
    }

    querySelectorSafe(root, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const el = root.querySelector(selector);
                if (el) return el;
            } catch {
                // ignore unsupported selector and continue
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Covers are background images on `div.product__item__pic[data-setbg]`.
    coverFrom(card) {
        const pic = this.querySelectorSafe(card, [this.selectMangaListPic, "div.product__item__pic", ".product__item__pic"]);
        if (pic) {
            const bg = pic.getAttribute(this.coverAttr) || pic.getAttribute("data-setbg") || pic.getAttribute("data-bg");
            if (bg) return this.toAbsoluteUrl(bg);
            // Some variants inline the image instead of a background.
            const inner = pic.querySelector("img");
            if (inner) return this.imageSrc(inner);
        }
        const img = card.querySelector("img");
        return img ? this.imageSrc(img) : "";
    }

    contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    async getListPage(page, order, filter = {}) {
        let url = `https://${this.domain}${this.listUrl}?page=${page}&type=all`;

        if (filter.query) {
            url += `&search=${encodeURIComponent(filter.query)}`;
        }
        // Single category (Kotlin uses oneOrThrowIfMany -> first tag only).
        const tag = filter.tags && filter.tags.length ? filter.tags[0] : null;
        if (tag && tag.key) {
            url += `&categorie=${encodeURIComponent(tag.key)}`;
        }

        url += "&sort=";
        switch (order) {
            case SortOrder.POPULARITY: url += "view"; break;
            case SortOrder.UPDATED: url += "updated"; break;
            case SortOrder.ALPHABETICAL: url += "default"; break;
            case SortOrder.NEWEST: url += "published"; break;
            default: url += "updated"; break;
        }

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const cards = this.queryAll(doc, [
            this.selectMangaList,
            "div.col-6 div.product__item",
            "div.product__item",
            ".product__item",
        ]);

        const mangaList = [];
        const seen = new Set();
        for (const card of cards) {
            const a = this.querySelectorSafe(card, [this.selectMangaListLink, "h5 a", "a"]);
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            if (seen.has(relHref)) continue;

            const titleEl = this.querySelectorSafe(card, [
                this.selectMangaListTitle,
                "div.product__item__text h5",
                "div.product__item__text",
                ".product__item__text",
                "h5",
            ]);
            const title = (titleEl ? titleEl.textContent : a.getAttribute("title") || a.textContent || "").trim();
            if (!title) continue;

            seen.add(relHref);
            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.coverFrom(card),
                title,
                source: this.source,
                contentRating: this.contentRating(),
            }));
        }
        return mangaList;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const title = (this.querySelectorSafe(doc, ["div.anime__details__title h3", "div.anime__details__text h3", "h1", "h3"])?.textContent || manga.title || "").trim();

        const descEl = this.querySelectorSafe(doc, [
            this.selectDesc,
            "div.anime__details__text p",
            "div.anime__details__text",
            "div.entry-content",
        ]);
        const description = descEl ? descEl.innerHTML : (manga.description || "");

        // State: presence of the "Ongoing"/"En cours" widget item => ONGOING.
        const stateEls = this.queryAll(doc, [
            this.selectState,
            "div.anime__details__widget li:contains(Ongoing)",
        ]);
        // `:contains()` is jsoup-only and may be unsupported by the DOM; fall back
        // to a textual scan of the details widget so state still resolves.
        let state;
        if (stateEls.length) {
            state = MangaState.ONGOING;
        } else {
            const widget = this.querySelectorSafe(doc, ["div.anime__details__widget", ".anime__details__widget"]);
            const widgetText = widget ? widget.textContent.toLowerCase() : "";
            const ongoingHit = /ongoing|en cours|berjalan|berlangsung|publishing|连载/.test(widgetText);
            const finishedHit = /completed|complete|tamat|finished|terminé|selesai|完结/.test(widgetText);
            state = ongoingHit ? MangaState.ONGOING : (finishedHit ? MangaState.FINISHED : MangaState.FINISHED);
        }

        // Tags from the "Categorie/Genre" widget anchors.
        const tagAnchors = this.queryAll(doc, [
            this.selectTag,
            "div.anime__details__widget li:contains(Categorie) a",
            "div.anime__details__widget li:contains(Genre) a",
            "div.anime__details__widget a[href*='categorie']",
            "div.anime__details__widget a[href*='genre']",
        ]);
        const tags = tagAnchors.map((a) => {
            const href = a.getAttribute("href") || "";
            // Kotlin: substringAfterLast('=') for `?categorie=key`; PapScan strips a
            // trailing slash then takes the last path segment.
            let key;
            if (href.includes("=")) {
                key = href.split("=").pop();
            } else {
                key = href.replace(/\/$/, "").split("/").pop();
            }
            return {
                key: (key || "").trim(),
                title: a.textContent.trim().replace(/,/g, ""),
            };
        }).filter((t) => t.key || t.title);

        const chapters = this.getChapters(doc);

        return new Manga({
            ...manga,
            title: title || manga.title,
            description,
            state,
            tags: tags.length ? tags : manga.tags,
            contentRating: this.contentRating(),
            source: this.source,
            chapters,
        });
    }

    // Returns chapters OLDEST-FIRST (Kotlin mapChapters(reversed = true)).
    getChapters(doc) {
        const anchors = this.queryAll(doc, [
            this.selectChapter,
            "div.anime__details__episodes a",
            "ul.chapters li a",
            "ul.chapters li",
            ".chapter-list li a",
        ]);

        // Newest-first in the DOM; reverse so index 0 is the oldest chapter.
        const reversed = anchors.slice().reverse();
        const chapters = [];
        const seen = new Set();

        reversed.forEach((node, i) => {
            // Node may be the <a> itself or an <li> wrapper.
            const a = node.tagName && node.tagName.toLowerCase() === "a" ? node : node.querySelector("a");
            if (!a) return;
            const href = a.getAttribute("href");
            if (!href) return;
            const relHref = this.toRelativeUrl(href);
            if (!relHref || relHref.includes("#") || seen.has(relHref)) return;
            seen.add(relHref);

            // PapScan keeps title in `span em`; the base template uses the anchor text.
            const titleEl = this.querySelectorSafe(node, ["span em", "span.chapter-title", ".chapternum"]);
            const title = (titleEl ? titleEl.textContent : a.textContent || "").trim() || `Chapter ${i + 1}`;
            const dateEl = this.querySelectorSafe(node, ["span.date-chapter-title-rtl", ".date-chapter-title-rtl", ".date"]);

            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: i + 1,
                volume: 0,
                uploadDate: 0,
                branch: null,
                scanlator: null,
                source: this.source,
            }));
        });

        return chapters;
    }

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);

        // Variant A: reader exposes a `var pages = [ { page_image: "..." }, ... ]`
        // JSON array inside a <script>. Extract it without eval.
        if (html.includes("page_image")) {
            const pages = this.parsePagesFromScript(html);
            if (pages.length) return pages;
        }

        // Variant B: <img> tags whose real URL hides in an onerror handler:
        //   onerror="this.onerror=null;this.src=`<url>`;"
        const doc = this.context.parseHTML(html);
        const imgs = this.queryAll(doc, [
            this.selectPage,
            "div.read-img img",
            ".read-img img",
            "#readerarea img",
            "div.reading-content img",
        ]);

        const pages = [];
        imgs.forEach((img) => {
            let url = "";
            const onerror = img.getAttribute("onerror") || "";
            if (onerror.includes("this.src")) {
                // Strip the wrapper: this.onerror=null;this.src=`URL`;
                url = onerror
                    .replace("this.onerror=null;this.src=`", "")
                    .replace(/`;?\s*$/, "")
                    .replace(/^this\.onerror=null;this\.src=["'`]/, "")
                    .replace(/["'`];?\s*$/, "")
                    .trim();
            }
            if (!url) url = this.imageSrc(img);
            if (!url) return;
            const abs = this.toAbsoluteUrl(url);
            pages.push(new MangaPage({
                id: abs,
                url: abs,
                source: this.source,
            }));
        });
        return pages;
    }

    // Pull the `var pages = [...]` array out of inline scripts and parse it as
    // JSON, then map each {page_image} entry to a MangaPage.
    parsePagesFromScript(html) {
        const candidates = [];
        // Most precise: the exact Kotlin shape `var pages = [ ... ];`
        let m = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\])\s*;/);
        if (m) candidates.push(m[1]);
        // Generic fallback: any array literal that contains page_image keys.
        if (!candidates.length) {
            const arrays = html.match(/\[[\s\S]*?page_image[\s\S]*?\]/g) || [];
            candidates.push(...arrays);
        }

        for (const raw of candidates) {
            try {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr) && arr.length) {
                    const pages = arr
                        .map((entry) => {
                            const url = entry && (entry.page_image || entry.image || entry.url);
                            if (!url) return null;
                            const abs = this.toAbsoluteUrl(url);
                            return new MangaPage({ id: abs, url: abs, source: this.source });
                        })
                        .filter(Boolean);
                    if (pages.length) return pages;
                }
            } catch {
                // Not valid JSON (single quotes / trailing commas); try regex below.
            }
        }

        // Last resort: scrape page_image string values directly.
        const urls = [];
        for (const mm of html.matchAll(/["']page_image["']\s*:\s*["']([^"']+)["']/g)) {
            urls.push(mm[1]);
        }
        return urls.map((u) => {
            const abs = this.toAbsoluteUrl(u.replace(/\\\//g, "/"));
            return new MangaPage({ id: abs, url: abs, source: this.source });
        });
    }
}
