import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * CupFoxParser — port of Nyora's CupFoxParser (key "cupfox").
 *
 * Concrete sources (all extend the same template with only a domain override):
 *   - MANGAKOINU  www.mangakoinu.com  (ja)
 *   - MANGAHAUS   www.mangahaus.com   (de)
 *   - SEINEMANGA  www.seinemanga.com  (fr)
 *   (others in the family: OIOIVN/vi, ENLIGNEMANGA/fr, FRMANGA/fr)
 *
 * CupFox sites are CMS skins (stui / ewave / dm / book-* themes) that render a
 * server-side "video/comic list" template. The Kotlin parser is a PagedMangaParser
 * (1-indexed pages) that does plain HTTP GET + HTML scraping for list, details and
 * pages — fully reproducible in a fetch + DOMParser browser context. No AJAX, no
 * JS VM, no image decryption is required by the family.
 */
export class CupFoxParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // ---- list / search selectors ----
        this.selectMangas =
            "ul.row li, ul.stui-vodlist li, ul.clearfix li.dm-list, div.vod-list ul.row li, ul.ewave-vodlist li";
        this.selectMangasCover =
            "div.img-wrapper, div.stui-vodlist__thumb, a.stui-vodlist__thumb, div.ewave-vodlist__thumb, img.dm-thumb";
        this.selectMangaTitle = "h3, h4, p.dm-bn";

        // ---- details selectors ----
        this.selectMangaDetailsAltTitle =
            "div.info span:contains(Autres noms), div.info span:contains(Biệt danh)";
        this.selectMangaDetailsTags =
            "div.info span a[href*=tags], p.data a[href*=tags], div.book-main-right p.info-text a[href*=tags]";
        this.selectMangaDetailsAuthor =
            "div.info span:contains(Auteur(s)), div.info span:contains(Tác giả), p.data span:contains(Auteur(s)), p.data span:contains(Autor), p.data span:contains(作者), div.book-main-right div.book-info:contains(作者) .info-text";
        this.selectMangaDescription =
            "div.vod-list:contains(Résumé) div.more-box, div.stui-pannel__head:contains(Résumé), div.book-desc div.info-text, div.info div.text:contains(Giới thiệu), #desc";
        this.selectMangaChapters =
            "div.episode-box ul li, ul.stui-content__playlist li a, ul.cnxh-ul li a, ul.ewave-content__playlist li a";

        // ---- pages selectors ----
        this.selectPages = "div.more-box li img, ul.main li img";

        // ---- tag discovery ----
        this.selectAvailableTags =
            "div.swiper-wrapper a[href*=tags], ul.stui-screen__list li a[href*=tags]";

        // ---- URL fragments (tunable per-source) ----
        this.searchPath = "/search/";       // /search/<query>/<page>
        this.categoryPath = "/category/";   // /category/order/<o>/[finish/<n>/][tags/<key>/]page/<page>
        this.orderPopularity = "order/hits/";
        this.orderUpdated = "order/addtime/";
        this.stateOngoing = "finish/1/";
        this.stateFinished = "finish/2/";
    }

    /**
     * Try each selector in order, returning the first non-empty match list.
     * Mirrors madara.js so minor markup drift / unsupported `:contains()` in
     * the browser DOM doesn't kill extraction.
     */
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // jsdom / browsers reject jQuery-ext selectors like :contains().
                // Fall through to the next, simpler selector.
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
                // ignore unsupported selector, try next
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-original") ||
               img.getAttribute("data-src") ||
               img.getAttribute("data-lazy-src") ||
               img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Kotlin requireSrc(): also honours data-original/data-src lazy attrs.
    requireSrc(img) {
        return this.imageSrc(img);
    }

    contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    /** key = last path segment of href (after stripping a trailing slash). */
    keyFromHref(href) {
        const clean = (href || "").replace(/\/+$/, "");
        const i = clean.lastIndexOf("/");
        return i >= 0 ? clean.slice(i + 1) : clean;
    }

    titleCase(text) {
        return (text || "")
            .toLowerCase()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    /** text after the last full-width or ASCII colon (mirrors substringAfter("：")). */
    afterColon(text) {
        if (!text) return "";
        const t = text.trim();
        const idx = t.lastIndexOf("：");
        if (idx >= 0) return t.slice(idx + 1).trim();
        const idx2 = t.lastIndexOf(":");
        return idx2 >= 0 ? t.slice(idx2 + 1).trim() : t;
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        const pageNo = page || 1; // PagedMangaParser is 1-indexed; harness passes 1.
        let url = `https://${this.domain}`;

        if (filter.query) {
            url += this.searchPath + encodeURIComponent(filter.query) + "/" + pageNo;
        } else {
            url += this.categoryPath;
            url += order === SortOrder.POPULARITY ? this.orderPopularity : this.orderUpdated;

            const state = this.oneState(filter.states);
            if (state === MangaState.ONGOING) url += this.stateOngoing;
            else if (state === MangaState.FINISHED) url += this.stateFinished;

            const tag = this.oneTag(filter.tags);
            if (tag) url += "tags/" + tag + "/";

            url += "page/" + pageNo;
        }

        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    oneState(states) {
        if (!states) return null;
        if (Array.isArray(states)) return states.length ? states[0] : null;
        return states; // already a scalar
    }

    oneTag(tags) {
        if (!tags) return null;
        let t = tags;
        if (Array.isArray(tags)) t = tags.length ? tags[0] : null;
        if (!t) return null;
        return typeof t === "string" ? t : (t.key || null);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const items = this.queryAll(doc, [
            this.selectMangas,
            "ul.stui-vodlist li",
            "ul.ewave-vodlist li",
            "div.vod-list ul.row li",
            "ul.row li",
            "ul.clearfix li.dm-list",
        ]);

        const list = [];
        for (const li of items) {
            const a = li.querySelector("a");
            if (!a) continue;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href) continue;

            const titleEl = this.queryFirst(li, [this.selectMangaTitle, "h3", "h4", "p.dm-bn"]);
            const coverEl = this.queryFirst(li, [
                this.selectMangasCover,
                "div.stui-vodlist__thumb",
                "a.stui-vodlist__thumb",
                "div.ewave-vodlist__thumb",
                "div.img-wrapper",
                "img.dm-thumb",
            ]);
            // cover selector may match a wrapper element holding the <img>, or the <img> itself.
            const coverImg = coverEl && coverEl.tagName === "IMG"
                ? coverEl
                : (coverEl ? coverEl.querySelector("img") : null) || li.querySelector("img");

            list.push(new Manga({
                id: href,
                url: href,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(coverImg),
                title: titleEl ? titleEl.textContent.trim() : (a.getAttribute("title") || a.textContent || "").trim(),
                source: this.source,
                contentRating: this.contentRating(),
            }));
        }
        return list;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const altEl = this.queryFirst(doc, [this.selectMangaDetailsAltTitle]);
        const altTitle = altEl ? this.afterColon(altEl.textContent) : "";

        const authorEl = this.queryFirst(doc, [this.selectMangaDetailsAuthor]);
        const author = authorEl ? this.afterColon(authorEl.textContent) : "";

        const descEl = this.queryFirst(doc, [
            this.selectMangaDescription,
            "div.book-desc div.info-text",
            "#desc",
        ]);
        const description = descEl ? descEl.innerHTML : "";

        const tagEls = this.queryAll(doc, [
            this.selectMangaDetailsTags,
            "a[href*=tags]",
        ]);
        const tags = tagEls.map((a) => ({
            key: this.keyFromHref(a.getAttribute("href")),
            title: this.titleCase(a.textContent.trim()),
            source: this.source,
        }));

        const chapterEls = this.queryAll(doc, [
            this.selectMangaChapters,
            "div.episode-box ul li",
            "ul.stui-content__playlist li a",
            "ul.ewave-content__playlist li a",
            "ul.cnxh-ul li a",
        ]);

        // Chapters are listed oldest-first in source; number = index + 1.
        const chapters = chapterEls.map((el, i) => {
            // selector may match either the <li> or the <a> directly.
            const a = el.tagName === "A" ? el : el.querySelector("a");
            if (!a) return null;
            const href = this.toRelativeUrl(a.getAttribute("href"));
            if (!href || href.includes("#")) return null;
            return new MangaChapter({
                id: href,
                url: href,
                title: a.textContent.trim(),
                number: i + 1,
                volume: 0,
                source: this.source,
            });
        }).filter(Boolean);

        return new Manga({
            ...manga,
            altTitles: altTitle ? [altTitle] : [],
            authors: author ? [author] : [],
            tags,
            description,
            chapters,
        });
    }

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);

        const imgs = this.queryAll(doc, [
            this.selectPages,
            "div.more-box li img",
            "ul.main li img",
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
