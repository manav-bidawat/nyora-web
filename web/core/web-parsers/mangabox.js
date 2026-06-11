import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangaBoxParser — handles Manganato and the classic Mangakakalot/Manganato
 * mirrors. The newer ".gg" rebrand (e.g. www.manganato.gg) is a SPA: the
 * chapter list is lazy-loaded from a JSON API and reader pages are injected
 * client-side from an embedded `chapterImages` array. We handle both that API
 * style and the legacy static-HTML style, picking whichever the page exposes.
 */
export class MangaBoxParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);
    }

    async getListPage(page, order, filter) {
        let url = `https://${this.domain}`;
        const isGg = this.domain.includes(".gg");

        // manganato.gg live-search is a JSON endpoint (the /search HTML page is
        // client-rendered and empty). GET /home/search/json?searchword={alias}
        // -> [{url, name, image, ...}]. NOTE: this endpoint is often behind a
        // Cloudflare JS challenge, so it can return empty headless (same as the
        // web app) — we degrade gracefully rather than error.
        if (filter.query && isGg) {
            const alias = String(filter.query).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            const jsonUrl = `https://${this.domain}/home/search/json?searchword=${encodeURIComponent(alias)}`;
            try {
                const j = await this.context.httpGet(jsonUrl, this);
                const arr = JSON.parse(j);
                return (Array.isArray(arr) ? arr : []).map(it => {
                    const href = it.url || it.link || "";
                    const rel = this.toRelativeUrl(href);
                    const title = String(it.name || it.title || "").replace(/<[^>]*>/g, "").trim();
                    const cover = it.image || it.cover || "";
                    return new Manga({
                        id: rel,
                        url: rel,
                        publicUrl: href || this.toAbsoluteUrl(rel),
                        coverUrl: cover && !cover.startsWith("data:") ? this.toAbsoluteUrl(cover) : "",
                        title: title,
                        source: this.source,
                        contentRating: ContentRating.SAFE
                    });
                }).filter(m => m.url && m.title);
            } catch { return []; }
        }

        if (filter.query) {
            if (isGg) {
                url += `/search?keyword=${encodeURIComponent(filter.query)}&page=${page}`;
            } else {
                url += `/search/story/${encodeURIComponent(filter.query.replace(/\s+/g, '_'))}`;
                if (page > 1) url += `?page=${page}`;
            }
        } else {
            if (isGg) {
                let type = "latest-manga";
                if (order === SortOrder.POPULARITY) type = "hot-manga";
                if (order === SortOrder.NEWEST) type = "new-manga";
                url += `/manga-list/${type}?page=${page}`;
            } else {
                const isNato = this.domain.includes("manganato");
                if (isNato) {
                    url += `/genre-all/${page}`;
                    let type = "topview";
                    if (order === SortOrder.NEWEST) type = "newest";
                    if (order === SortOrder.UPDATED) type = "latest";
                    url += `?type=${type}`;
                } else {
                    url += `/manga_list?type=topview&category=all&state=all&page=${page}`;
                    if (order === SortOrder.NEWEST) url = url.replace("topview", "newest");
                    if (order === SortOrder.UPDATED) url = url.replace("topview", "latest");
                }
            }
        }

        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);

        // Match ANY container that looks like a manga item
        const elements = doc.querySelectorAll([
            ".list-truyen-item-wrap",
            ".content-genres-item",
            ".truyen-item",
            ".itemupdate",
            ".item",
            ".xem-nhieu-item",
            "div.story_item",
            "div.list-story-item"
        ].join(","));

        const mangaList = [];
        for (const el of Array.from(elements)) {
            // Find the main link
            const a = el.querySelector("h3 a, h2 a, a.genres-item-name, a.item-img, a.tooltip, a[title]");
            if (!a) continue;

            const href = a.getAttribute("href");
            if (!href || href.includes("/chapter-")) continue;

            const relHref = this.toRelativeUrl(href);
            const img = el.querySelector("img");
            const titleEl = el.querySelector("h3, h2, .genres-item-name, .item-name, .title");

            // Lazy loading is extremely common
            let coverUrl = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
            if (coverUrl && !coverUrl.startsWith("data:")) {
                coverUrl = this.toAbsoluteUrl(coverUrl);
            } else {
                coverUrl = "";
            }

            mangaList.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: coverUrl,
                title: (titleEl || a).textContent.trim(),
                source: this.source,
                contentRating: ContentRating.SAFE
            }));
        }
        return mangaList;
    }

    async getDetails(manga) {
        const url = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);

        const title = doc.querySelector("h1, .story-info-right h1, .panel-story-info h1, .title-manga, .manga-info-text h1")?.textContent?.trim() || manga.title;
        const desc = doc.querySelector("#noidungm, .panel-story-info-description, .story-info-full, .content-manga, #panel-story-info-description, .description-content, .summary__content")?.textContent?.trim() || "";
        const img = doc.querySelector(".manga-info-pic img, .panel-story-info img, .info-image img, .cover img, .story-info-left img");

        let coverUrl = manga.coverUrl;
        if (img) {
            const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
            if (raw && !raw.startsWith("data:")) coverUrl = this.toAbsoluteUrl(raw);
        }

        let chapters = [];

        // --- .gg API style: chapter list comes from a paginated JSON endpoint ---
        // The static HTML may carry a <div id="chapter-list-container" data-api-url=...
        // data-chapter-url-template=...> hint, but that container is UA-dependent and
        // unreliable, so for .gg domains we ALWAYS try the API directly using the slug
        // from the manga url. API shape:
        //   GET /api/manga/{slug}/chapters?offset=N
        //   -> { data: { chapters: [{chapter_name, chapter_slug, chapter_num}], pagination: {total, limit, offset, has_more} } }
        const isGg = this.domain.includes(".gg");
        const apiEl = doc.querySelector("#chapter-list-container[data-api-url], [data-comic-slug][data-api-url], [data-api-url][data-chapter-url-template]");
        if (isGg || apiEl) {
            const slugMatch = String(manga.url || "").match(/\/manga\/([^/?#]+)/);
            const slug = (apiEl && apiEl.getAttribute("data-comic-slug")) || (slugMatch ? slugMatch[1] : "");
            let apiBase = (apiEl && apiEl.getAttribute("data-api-url")) || "";
            if (apiBase.includes("__SLUG__")) apiBase = apiBase.replace(/__SLUG__/g, slug);
            if (!apiBase && slug) apiBase = `https://${this.domain}/api/manga/${slug}/chapters`;
            const urlTmpl = (apiEl && apiEl.getAttribute("data-chapter-url-template")) || "";

            if (apiBase && slug) {
                try {
                    const collected = [];
                    let offset = 0;
                    for (let guard = 0; guard < 100; guard++) {
                        const sep = apiBase.includes("?") ? "&" : "?";
                        const apiJson = await this.context.httpGet(`${apiBase}${sep}offset=${offset}`, this);
                        const parsed = JSON.parse(apiJson);
                        const batch = (parsed && parsed.data && parsed.data.chapters) || [];
                        if (!batch.length) break;
                        collected.push(...batch);
                        const pg = (parsed && parsed.data && parsed.data.pagination) || {};
                        const limit = Number(pg.limit) || batch.length || 50;
                        const total = Number(pg.total) || 0;
                        offset += limit;
                        const more = pg.has_more === true || (total > 0 ? collected.length < total : batch.length >= limit);
                        if (!more) break;
                    }
                    chapters = collected.map((c, i) => {
                        const chSlug = c.chapter_slug || c.slug || "";
                        let chUrl;
                        if (urlTmpl) {
                            chUrl = urlTmpl.replace(/__MANGA__/g, slug).replace(/__CHAPTER__/g, chSlug);
                        } else {
                            chUrl = `https://${this.domain}/manga/${slug}/${chSlug}`;
                        }
                        const rel = this.toRelativeUrl(chUrl);
                        return new MangaChapter({
                            id: rel,
                            url: rel,
                            title: c.chapter_name || c.name || `Chapter ${c.chapter_num != null ? c.chapter_num : i + 1}`,
                            number: Number(c.chapter_num != null ? c.chapter_num : c.number) || (i + 1),
                            source: this.source
                        });
                    }).filter(c => c.url);
                    // API returns newest-first; the UI convention is oldest-first.
                    chapters.reverse();
                } catch { chapters = []; }
            }
        }

        // --- Classic static-HTML chapter list (fallback) ---
        if (!chapters.length) {
            let elements = Array.from(doc.querySelectorAll([
                ".chapter-list .row",
                ".row-content-chapter li",
                ".chapter-list li",
                ".row-content-chapter .a-h",
                ".panel-story-chapter-list li",
                ".panel-story-chapter-list .a-h",
                "ul.list-chapter li",
                ".list-chapter .row",
                ".chapter-list div.row"
            ].join(",")));

            // If empty, try the legacy AJAX endpoint.
            if (!elements.length) {
                const idEl = doc.querySelector("a[data-id], #manga_id, input[name='manga_id'], .bookmark_check[data-id]");
                const mangaId = idEl ? idEl.getAttribute("data-id") || idEl.value : null;
                if (mangaId) {
                    try {
                        const ajaxUrl = `https://${this.domain}/ajax/chapter/list?manga_id=${mangaId}`;
                        const ajaxHtml = await this.context.httpGet(ajaxUrl, this);
                        const ajaxDoc = this.context.parseHTML(ajaxHtml);
                        elements = Array.from(ajaxDoc.querySelectorAll("li, .row, a"));
                    } catch { /* ignore */ }
                }
            }

            // Last ditch: any explicit /chapter- anchors.
            if (!elements.length) {
                elements = Array.from(doc.querySelectorAll("a[href*='/chapter-']")).map(a => a.closest("li, div.row, div.item, .a-h") || a);
            }

            chapters = elements.map((el, i) => {
                const a = el.tagName === 'A' ? el : el.querySelector("a");
                const href = a?.getAttribute("href");
                if (!href) return null;
                const relHref = this.toRelativeUrl(href);
                return new MangaChapter({
                    id: relHref,
                    url: relHref,
                    title: a?.textContent?.trim() || `Chapter ${i + 1}`,
                    number: i + 1,
                    source: this.source
                });
            }).filter(c => c && c.url && !c.url.includes("javascript:void")).reverse();
        }

        // Genres: .gg shows them in a .genre-list; classic skins use the info table.
        // Scope tightly to the manga's own genre container — a broad a[href*='/genre/']
        // also catches the site-wide genre nav menu (dozens of links).
        const genreEls = doc.querySelectorAll(
            ".genres-wrap .genre-list a, .panel-story-info .table-value a[href*='/genre/'], .story-info-right .table-value a[href*='/genre/'], li.genres a[href*='/genre/']"
        );
        const seenTag = {};
        const tags = Array.from(genreEls).map((a) => {
            const title = (a.textContent || "").trim();
            const href = a.getAttribute("href") || "";
            const key = ((href.match(/\/genre\/([^/?#]+)/) || [])[1]) || title.toLowerCase();
            return { title, key };
        }).filter((g) => {
            const t = g.title.toLowerCase();
            if (!g.title || t === "all" || t === "completed" || t === "ongoing" || t === "latest") return false;
            if (seenTag[g.key]) return false;
            seenTag[g.key] = true;
            return true;
        });

        return new Manga({
            ...manga,
            title,
            coverUrl,
            description: desc,
            tags: tags,
            chapters: chapters
        });
    }

    async getPages(chapter) {
        const url = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(url, this);

        // --- .gg reader: pages embedded as a JS array, injected client-side ---
        //   var cdns = ["https:\/\/imgs-2.2xstorage.com"];
        //   var chapterImages = ["slug\/1\/0.webp", ...];
        const imagesMatch = html.match(/chapterImages\s*=\s*(\[[\s\S]*?\])/);
        if (imagesMatch) {
            let paths = [];
            try { paths = JSON.parse(imagesMatch[1].replace(/\\\//g, "/")); } catch { paths = []; }
            if (paths.length) {
                let base = "";
                const cdnMatch = html.match(/cdns\s*=\s*(\[[\s\S]*?\])/);
                if (cdnMatch) {
                    try { const cdns = JSON.parse(cdnMatch[1].replace(/\\\//g, "/")); base = (cdns && cdns[0]) || ""; } catch { /* ignore */ }
                }
                if (!base) base = "https://imgs-2.2xstorage.com";
                base = base.replace(/\/+$/, "");
                return paths
                    .map(p => {
                        const s = String(p).replace(/\\\//g, "/").replace(/^\/+/, "");
                        const full = /^https?:\/\//.test(s) ? s : `${base}/${s}`;
                        return new MangaPage({
                            id: full,
                            url: full,
                            source: this.source,
                            headers: { "Referer": `https://${this.domain}/` }
                        });
                    })
                    .filter(pg => pg.url && !pg.url.includes("/banners-web/") && !pg.url.includes("yougetwhatyoupayfor") && !pg.url.includes("/thumb/"));
            }
        }

        // --- Classic static reader (fallback) ---
        const doc = this.context.parseHTML(html);
        const images = doc.querySelectorAll([
            ".container-chapter-reader img",
            ".v-content img",
            ".reader-content img",
            ".chapter-content img",
            "#v-content img"
        ].join(","));

        return Array.from(images).map(img => {
            const imageUrl = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
            return new MangaPage({
                id: imageUrl,
                url: imageUrl,
                source: this.source,
                headers: { "Referer": `https://${this.domain}/` }
            });
        }).filter(p => p.url && !p.url.includes("ads") && !p.url.includes("logo") && !p.url.startsWith("data:"));
    }
}
