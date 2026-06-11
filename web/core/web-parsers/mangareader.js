import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

export class MangaReaderParser extends BaseParser {
    constructor(context, source, domain, pageSize = 12) {
        super(context, source, domain, pageSize);
        this.listUrl = "/manga";
        this.datePattern = "MMMM d, yyyy";
        this.selectMangaList = ".postbody .listupd .bs .bsx";
        this.selectMangaListImg = "img.ts-post-image";
        this.selectMangaListTitle = "div.tt";
        this.selectChapter = "#chapterlist > ul > li";
        this.encodedSrc = false;
        this.selectScript = "div.wrapper script";
        this.selectPage = "div#readerarea img";
        this.selectTestScript = "ts_reader"; // simplified to just look for keyword
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some source overrides use selectors that are not supported by
                // every browser/DOM implementation. Try the next known shape.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        return this.toImageUrl(url);
    }

    toImageUrl(url) {
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    chapterTitle(el, a) {
        const direct = el.querySelector(".chapternum, .chapter-title, .judulseries, .lchx")?.textContent?.trim();
        if (direct) return direct;
        const lines = (a?.textContent || el.textContent || "")
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
        return lines[0] || "";
    }

    async getListPage(page, order, filter) {
        let url = `https://${this.domain}`;
        if (filter.query) {
            url += `/page/${page}/?s=${encodeURIComponent(filter.query)}`;
        } else {
            url += this.listUrl;
            url += "/?order=";
            switch (order) {
                case SortOrder.ALPHABETICAL: url += "title"; break;
                case SortOrder.ALPHABETICAL_DESC: url += "titlereverse"; break;
                case SortOrder.NEWEST: url += "latest"; break;
                case SortOrder.POPULARITY: url += "popular"; break;
                case SortOrder.UPDATED: url += "update"; break;
            }
            if (filter.tags) {
                filter.tags.forEach(t => url += `&genre[]=${encodeURIComponent(t.key)}`);
            }
            url += `&page=${page}`;
        }
        
        const html = await this.context.httpGet(url, this);
        return this.parseMangaList(html);
    }

    parseMangaList(html) {
        const doc = this.context.parseHTML(html);
        const elements = this.queryAll(doc, [
            this.selectMangaList,
            ".postbody .listupd .bs .bsx",
            ".listupd .bs .bsx",
            ".listupd .bs",
            "div.animepost",
            "div.bge",
        ]);
        const mangaList = [];

        for (const el of elements) {
            const a = el.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            const relHref = this.toRelativeUrl(href);
            
            const titleEl = el.querySelector(this.selectMangaListTitle);
            const img = el.querySelector(this.selectMangaListImg) || el.querySelector("img");
            
            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.imageSrc(img),
                title: titleEl ? titleEl.textContent.trim() : (a.getAttribute("title") || a.textContent || "").trim(),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE
            }));
        }
        return mangaList;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        const title = doc.querySelector("h1.entry-title, .postbody h1")?.textContent?.trim() || manga.title;
        const desc = doc.querySelector("div.entry-content")?.innerHTML || "";
        
        // Chapters
        const elements = this.queryAll(doc, [
            this.selectChapter,
            "#chapterlist > ul > li",
            "#chapterlist li",
            ".listing-chapters_wrap li",
            ".eplister li",
            ".episodelist li",
            ".bixbox.bxcl li",
            ".chapter-list li",
            "#Daftar_Chapter tr",
            "li.wp-manga-chapter",
            "div.wp-manga-chapter",
        ]).reverse();
        const chapters = elements.map((el, i) => {
            const a = el.querySelector("a");
            const href = a?.getAttribute("href");
            const relHref = href ? this.toRelativeUrl(href) : "";
            const title = this.chapterTitle(el, a);
            return new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: i + 1,
                source: this.source
            });
        }).filter(c => c.url && !c.url.endsWith("/manga/") && !c.url.includes("#"));

        return new Manga({
            ...manga,
            title,
            description: desc,
            chapters: chapters
        });
    }

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);
        
        const hasTsReader = html.includes(this.selectTestScript);
        
        if (!hasTsReader && !this.encodedSrc) {
            const images = doc.querySelectorAll(this.selectPage);
            return Array.from(images).map(img => {
                const imageUrl = this.toImageUrl(this.imageSrc(img));
                return new MangaPage({
                    id: imageUrl,
                    url: imageUrl,
                    source: this.source
                });
            });
        } else {
            // Very simplified JSON extraction logic
            try {
                const match = html.match(/ts_reader\.run\((.*?)\);/s);
                if (match) {
                    const data = JSON.parse(match[1]);
                    const images = data.sources[0].images;
                    return images.map(url => {
                        const imageUrl = this.toImageUrl(url);
                        return new MangaPage({
                            id: imageUrl,
                            url: imageUrl,
                            source: this.source
                        });
                    });
                }
            } catch (e) {
            }
            return [];
        }
    }
}
