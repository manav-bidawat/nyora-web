import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * IkenParser — Next.js / "iken" template sources (VortexScans, MagusToon,
 * NyxScans, HiveComic, EzManga, ...).
 *
 * Ported from Nyora IkenParser.kt. These sites are Next.js front-ends backed
 * by a JSON API. The list / details / chapter-list / page-image data all come
 * from `https://api.<domain>/api/...` JSON endpoints (useApi). When the API is
 * disabled or fails, page images are recovered from the embedded Next.js
 * `self.__next_f` script payload in the chapter HTML (getNextJson).
 *
 * Locked / paid chapters return isAccessible=false from the API and have no
 * readable images for an anonymous client — this is a site paywall, not a
 * parser limitation. getPages on such a chapter yields no pages (the harness
 * tests the oldest chapter, which is normally free).
 */
export class IkenParser extends BaseParser {
    constructor(context, source, domain, pageSize = 18) {
        super(context, source, domain, pageSize);

        // Most concrete iken sources talk to a separate api.<domain> host.
        this.useApi = true;
        // Per-source override hook: explicit API domain. Defaults to api.<domain>.
        this.apiDomainOverride = null;

        this.datePattern = "yyyy-MM-dd"; // informational; we keep ISO timestamps

        // Selectors for the HTML fallback page extraction.
        this.selectPages = "main section img";
        this.selectLock = "svg.lucide-lock";

        // Tunable endpoint fragments so per-source overrides can patch them.
        this.queryPath = "/api/query";
        this.chaptersPath = "/api/chapters";
        this.chapterPath = "/api/chapter";
        this.seriesPathPrefix = "/series/";
        this.listPerPage = 18;
    }

    get apiDomain() {
        if (this.apiDomainOverride) return this.apiDomainOverride;
        return this.useApi ? `api.${this.domain}` : this.domain;
    }

    apiHeaders() {
        return {
            'Accept': 'application/json, text/plain, */*',
            'Origin': `https://${this.domain}`,
            'Referer': `https://${this.domain}/`,
        };
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to a simpler selector shape.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    async getJson(url, headers) {
        const text = await this.context.httpGet(url, this);
        return JSON.parse(text);
    }

    mapState(status) {
        switch (String(status || "").toUpperCase()) {
            case "ONGOING":
            case "MASS_RELEASED":
                return MangaState.ONGOING;
            case "COMPLETED":
                return MangaState.FINISHED;
            case "DROPPED":
            case "CANCELLED":
                return MangaState.ABANDONED;
            case "COMING_SOON":
                return MangaState.UPCOMING;
            case "HIATUS":
                return MangaState.PAUSED;
            default:
                return undefined;
        }
    }

    mapSeriesType(order, filter) {
        // The list endpoint accepts &seriesStatus= from filter.states.
        const states = (filter && filter.states) || [];
        const first = Array.isArray(states) ? states[0] : states;
        switch (first) {
            case MangaState.ONGOING: return "ONGOING";
            case MangaState.FINISHED: return "COMPLETED";
            case MangaState.UPCOMING: return "COMING_SOON";
            case MangaState.ABANDONED: return "DROPPED";
            default: return "";
        }
    }

    // ---- List ----------------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        const perPage = this.pageSize || this.listPerPage || 18;
        let url = `https://${this.apiDomain}${this.queryPath}?page=${page}&perPage=${perPage}&searchTerm=`;
        if (filter.query) url += encodeURIComponent(filter.query);

        if (filter.tags && filter.tags.length) {
            const ids = filter.tags.map((t) => (t && (t.key != null ? t.key : t))).filter((k) => k != null);
            if (ids.length) url += `&genreIds=${ids.join(",")}`;
        }

        url += `&seriesType=`; // type filtering not exposed by Nyora filter here
        url += `&seriesStatus=${this.mapSeriesType(order, filter)}`;

        const json = await this.getJson(url, this.apiHeaders());
        return this.parseMangaList(json);
    }

    parseMangaList(json) {
        const posts = (json && Array.isArray(json.posts)) ? json.posts : [];
        const out = [];
        for (const it of posts) {
            const slug = it.slug;
            if (!slug) continue;
            const url = `${this.seriesPathPrefix}${slug}`;
            const isNsfwSource = it.hot === true || this.source.isNsfw === true;
            const author = (it.author && String(it.author).trim()) || null;
            const description = it.postContent || it.description || "";
            out.push(new Manga({
                id: it.id != null ? it.id : url,
                url,
                publicUrl: this.toAbsoluteUrl(url),
                coverUrl: it.featuredImage || "",
                title: it.postTitle || it.title || "",
                altTitles: it.alternativeTitles ? [it.alternativeTitles] : [],
                description,
                rating: 0,
                tags: [],
                authors: author ? [author] : [],
                state: this.mapState(it.seriesStatus),
                source: this.source,
                contentRating: isNsfwSource ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return out;
    }

    // ---- Details / Chapters --------------------------------------------

    seriesIdFromManga(manga) {
        // Prefer the numeric post id; fall back to nothing (slug-only lookup).
        if (manga.id != null && /^\d+$/.test(String(manga.id))) return String(manga.id);
        return null;
    }

    slugFromUrl(url) {
        const rel = this.toRelativeUrl(url || "");
        const m = rel.match(/\/series\/([^/?#]+)/);
        return m ? m[1] : "";
    }

    async getDetails(manga) {
        let seriesId = this.seriesIdFromManga(manga);
        const slugFromManga = this.slugFromUrl(manga.url);

        // If we don't have a numeric id (e.g. opened by slug only), resolve it.
        // Capture the full query post too — it carries genres (the chapters API does not).
        let queryPost = null;
        if (!seriesId && slugFromManga) {
            queryPost = await this.findPostBySlug(slugFromManga);
            seriesId = (queryPost && queryPost.id != null) ? String(queryPost.id) : null;
        }
        if (!seriesId) throw new Error("Unable to resolve series id for details");

        const url = `https://${this.apiDomain}${this.chaptersPath}?postId=${seriesId}&skip=0&take=900&order=desc&userid=`;
        const json = await this.getJson(url, this.apiHeaders());
        const post = (json && json.post) || {};
        const slug = post.slug || slugFromManga || "";
        const data = Array.isArray(post.chapters) ? post.chapters : [];

        // API returns newest-first (order=desc); reverse for oldest-first.
        const ordered = data.slice().reverse();
        const chapters = ordered.map((it, i) => {
            const slugName = (slug && String(slug)) ||
                (it.mangaPost && it.mangaPost.slug) || "";
            const chapterUrl = `${this.seriesPathPrefix}${slugName}/${it.slug}`;
            const number = Number(it.number) || 0;
            const extra = (it.title && String(it.title).trim()) ? ` - ${String(it.title).trim()}` : "";
            return new MangaChapter({
                id: it.id != null ? it.id : chapterUrl,
                url: chapterUrl,
                title: `Chapter ${this.formatNumber(number)}${extra}`,
                number,
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: it.createdAt ? new Date(it.createdAt).getTime() : 0,
                source: this.source,
                index: i,
            });
        });

        const meta = post;
        const qp = queryPost || {};
        const genres = Array.isArray(meta.genres) ? meta.genres
            : (Array.isArray(qp.genres) ? qp.genres : []);
        return new Manga({
            ...manga,
            title: meta.postTitle || qp.postTitle || manga.title,
            coverUrl: meta.featuredImage || qp.featuredImage || manga.coverUrl || "",
            largeCoverUrl: meta.featuredImage || qp.featuredImage || manga.largeCoverUrl || manga.coverUrl || "",
            description: meta.postContent || meta.description || qp.postContent || manga.description || "",
            tags: genres.map((g) => ({ title: g.name || g.title || String(g), key: String(g.id != null ? g.id : (g.name || g)) })),
            state: this.mapState(meta.seriesStatus) || this.mapState(qp.seriesStatus) || manga.state,
            chapters,
        });
    }

    formatNumber(n) {
        if (Number.isInteger(n)) return String(n);
        return String(n);
    }

    // Resolve a series slug to its full query post (carries id, genres, cover).
    // The API searches by title text, not by slug, so a raw hyphenated slug
    // (especially one with an apostrophe, e.g. "...female-lead's-sister...")
    // returns nothing. Search with a cleaned title-like term first, then fall
    // back to the raw slug. Always prefer an exact slug match in the results.
    async findPostBySlug(seriesSlug) {
        const cleaned = String(seriesSlug).replace(/[^a-zA-Z0-9]+/g, " ").trim();
        const terms = cleaned && cleaned !== seriesSlug ? [cleaned, seriesSlug] : [seriesSlug];
        for (const term of terms) {
            try {
                const json = await this.getJson(
                    `https://${this.apiDomain}${this.queryPath}?page=1&perPage=20&searchTerm=${encodeURIComponent(term)}`,
                    this.apiHeaders());
                const posts = (json && Array.isArray(json.posts)) ? json.posts : [];
                if (!posts.length) continue;
                const exact = posts.find((p) => p.slug === seriesSlug);
                const hit = exact || posts[0];
                if (hit && hit.id != null) return hit;
            } catch { /* try next term */ }
        }
        return null;
    }

    async findPostIdBySlug(seriesSlug) {
        const post = await this.findPostBySlug(seriesSlug);
        return (post && post.id != null) ? String(post.id) : null;
    }

    // ---- Pages ---------------------------------------------------------

    async getPages(chapter) {
        // API path first (when enabled).
        if (this.useApi) {
            try {
                const apiPages = await this.readChapterImages(chapter.id);
                if (apiPages && apiPages.length) return apiPages;
            } catch (e) {
                if (String(e && e.message).toLowerCase().includes("unlock")) throw e;
                // Otherwise fall through to HTML extraction.
            }
            // If we don't have a numeric chapter id, try resolving via the
            // series chapters API using the url slug pair.
            const numericId = /^\d+$/.test(String(chapter.id)) ? null : await this.resolveChapterId(chapter);
            if (numericId) {
                try {
                    const apiPages = await this.readChapterImages(numericId);
                    if (apiPages && apiPages.length) return apiPages;
                } catch (e) {
                    if (String(e && e.message).toLowerCase().includes("unlock")) throw e;
                }
            }
        }

        // HTML fallback: scrape embedded Next.js data / <img> tags.
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        if (doc.querySelector(this.selectLock)) {
            throw new Error("Need to unlock chapter!");
        }

        // Try the embedded Next.js "images" JSON first (most reliable).
        const fromNext = this.extractNextImages(html);
        if (fromNext.length) {
            return fromNext.map((u) => new MangaPage({ id: u, url: u, source: this.source }));
        }

        const imgs = this.queryAll(doc, [this.selectPages, "main section img", "section img", "img"]);
        const urls = [];
        const seen = new Set();
        for (const img of imgs) {
            const u = this.imageSrc(img);
            if (!u || u.startsWith("data:") || seen.has(u)) continue;
            // Skip obvious UI/avatar assets.
            if (/\/(logo|avatar|icon|banner)\b/i.test(u)) continue;
            seen.add(u);
            urls.push(u);
        }
        return urls.map((u) => new MangaPage({ id: u, url: u, source: this.source }));
    }

    async resolveChapterId(chapter) {
        const rel = this.toRelativeUrl(chapter.url).split("?")[0];
        const parts = rel.replace(/^\/+|\/+$/g, "").split("/");
        if (parts.length < 3 || parts[0] !== "series") return null;
        const seriesSlug = parts[1];
        const chapterSlug = parts[2];
        const postId = await this.findPostIdBySlug(seriesSlug);
        if (!postId) return null;
        try {
            const json = await this.getJson(
                `https://${this.apiDomain}${this.chaptersPath}?postId=${postId}&skip=0&take=900&order=desc&userid=`,
                this.apiHeaders());
            const list = (json && json.post && Array.isArray(json.post.chapters)) ? json.post.chapters : [];
            const hit = list.find((c) => c.slug === chapterSlug);
            return (hit && hit.id != null && Number(hit.id) > 0) ? String(hit.id) : null;
        } catch {
            return null;
        }
    }

    async readChapterImages(chapterId) {
        if (chapterId == null || !/^\d+$/.test(String(chapterId)) || Number(chapterId) <= 0) return [];
        const json = await this.getJson(
            `https://${this.apiDomain}${this.chapterPath}?chapterId=${chapterId}`,
            this.apiHeaders());
        const chapterJson = json && json.chapter;
        if (!chapterJson) return [];
        if (chapterJson.isLocked === true || chapterJson.isAccessible === false) {
            throw new Error("Need to unlock chapter!");
        }
        const images = Array.isArray(chapterJson.images) ? chapterJson.images : [];
        const pages = images.map((item) => {
            if (!item) return null;
            const url = item.url || item.src || item.image;
            if (!url) return null;
            return {
                order: this.parseOrder(item.order),
                url: String(url).replace("/public//", "/public/"),
            };
        }).filter(Boolean).sort((a, b) => a.order - b.order);

        return pages.map((p) => new MangaPage({ id: p.url, url: p.url, source: this.source }));
    }

    parseOrder(v) {
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
    }

    // Extract image URLs from the embedded Next.js flight payload. The Kotlin
    // getNextJson finds the script containing "images" and grabs the JSON array
    // following it. Here we scan all <script> bodies for an "images":[...] array
    // whose objects carry a "url".
    extractNextImages(html) {
        const out = [];
        const seen = new Set();
        // Look for the `images` array; payloads escape slashes (\/) and quotes.
        const candidates = [];
        let idx = 0;
        while ((idx = html.indexOf('images', idx)) !== -1) {
            const arrStart = html.indexOf('[', idx);
            if (arrStart === -1) { idx += 6; continue; }
            // Bound the search so a stray "images" word doesn't scan the whole doc.
            if (arrStart - idx > 8) { idx += 6; continue; }
            let depth = 1, i = arrStart + 1;
            while (i < html.length && depth > 0) {
                const c = html[i];
                if (c === '[') depth++;
                else if (c === ']') depth--;
                i++;
            }
            candidates.push(html.substring(arrStart, i));
            idx = i;
        }
        for (let raw of candidates) {
            const cleaned = raw.replace(/\\\//g, "/").replace(/\\"/g, '"');
            let arr;
            try { arr = JSON.parse(cleaned); } catch { continue; }
            if (!Array.isArray(arr)) continue;
            const withOrder = [];
            for (const item of arr) {
                if (!item || typeof item !== 'object') continue;
                const url = item.url || item.src || item.image;
                if (!url || typeof url !== 'string') continue;
                if (!/^https?:\/\//.test(url)) continue;
                withOrder.push({ order: this.parseOrder(item.order), url: url.replace("/public//", "/public/") });
            }
            if (withOrder.length) {
                withOrder.sort((a, b) => a.order - b.order);
                for (const w of withOrder) {
                    if (seen.has(w.url)) continue;
                    seen.add(w.url);
                    out.push(w.url);
                }
                if (out.length) break;
            }
        }
        return out;
    }
}
