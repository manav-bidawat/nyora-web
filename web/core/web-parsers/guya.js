import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * GuyaParser — Guya / Cubari-backed manga readers.
 *
 * This family is NOT HTML-scraped: every endpoint returns JSON. Ported from
 * Nyora's GuyaParser (SinglePageMangaParser).
 *
 *   - List:    GET /api/get_all_series/      -> { "<Title>": { slug, cover, author, description, ... }, ... }
 *   - Details: GET /api/series/<slug>/       -> { slug, title, chapters: { "<num>": { title, folder, groups: {...} } } }
 *   - Pages:   reuses the same /api/series/<slug>/ JSON; image URLs are built from
 *              /media/manga/<slug>/chapters/<folder>/<groupKey>/<filename>
 *
 * Concrete sources: DANKE (danke.moe), GUYACUBARI (guya.cubari.moe),
 * HACHIRUMI (hachirumi.com, NSFW), MAHOUSHOUJOBU (mahoushoujobu.com).
 *
 * Only ALPHABETICAL ordering exists upstream and search is a client-side
 * substring match over series titles (matching the Kotlin behaviour).
 */
export class GuyaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 1000) {
        super(context, source, domain, pageSize);
        // Tunable endpoint fragments so per-source overrides can patch them.
        this.allSeriesPath = "/api/get_all_series/";
        this.seriesApiPath = "/api/series/";   // + slug (+ trailing slash)
        this.readPath = "/read/manga/";        // public-facing reader URL prefix
        this.mediaPath = "/media/manga/";      // image CDN prefix
    }

    contentRating() {
        return (this.source && this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE;
    }

    async getJson(url) {
        const text = await this.context.httpGet(url, this);
        return JSON.parse(text);
    }

    // Series API URLs need a trailing slash; the backend 301-redirects
    // /api/series/<slug> -> /api/series/<slug>/ and the redirect can drop the
    // request through some proxies. Normalize defensively.
    withTrailingSlash(url) {
        return url.endsWith("/") ? url : url + "/";
    }

    seriesApiUrl(slug) {
        return this.withTrailingSlash(`https://${this.domain}${this.seriesApiPath}${slug}`);
    }

    async getListPage(page, order, filter) {
        // Single-page parser: everything is returned on the first request.
        // Subsequent pages are empty so paginated callers terminate cleanly.
        if (page && page > 1) return [];

        const url = `https://${this.domain}${this.allSeriesPath}`;
        const json = await this.getJson(url);
        const query = (filter && filter.query) ? String(filter.query).toLowerCase() : "";

        const list = [];
        for (const name of Object.keys(json)) {
            const entry = json[name];
            // get_all_series mixes in non-object metadata keys; skip those.
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            if (!entry.slug) continue;
            if (query && !name.toLowerCase().includes(query)) continue;
            list.push(this.toManga(entry, name));
        }
        return list;
    }

    toManga(entry, name) {
        const slug = entry.slug;
        const apiUrl = this.seriesApiUrl(slug);
        const publicUrl = `https://${this.domain}${this.readPath}${slug}`;
        const cover = entry.cover ? this.toAbsoluteUrl(entry.cover) : "";
        const author = entry.author || entry.artist;
        return new Manga({
            id: apiUrl,
            url: apiUrl,
            publicUrl,
            coverUrl: cover,
            largeCoverUrl: cover,
            title: name,
            altTitles: [],
            rating: 0,
            tags: [],
            description: entry.description || "",
            state: null,
            authors: author ? [author] : [],
            contentRating: this.contentRating(),
            source: this.source,
        });
    }

    async getDetails(manga) {
        const apiUrl = this.withTrailingSlash(this.toAbsoluteUrl(manga.url));
        const data = await this.getJson(apiUrl);
        const json = data.chapters || {};
        // slug is the last path segment of the series API URL.
        const slug = data.slug || this.lastSegment(this.stripTrailingSlash(manga.url));

        const chapters = [];
        const keys = Object.keys(json);
        keys.forEach((key, i) => {
            const chapter = json[key] || {};
            const url = `https://${this.domain}${this.seriesApiPath}${slug}/${key}`;
            chapters.push(new MangaChapter({
                id: url,
                url,
                title: chapter.title || `Chapter ${key}`,
                number: i + 1,
                volume: Number(chapter.volume) || 0,
                branch: null,
                scanlator: null,
                uploadDate: 0,
                source: this.source,
            }));
        });

        return new Manga({ ...manga, chapters });
    }

    async getPages(chapter) {
        // chapter.url = https://<domain>/api/series/<slug>/<chapterKey>
        const stripped = this.stripTrailingSlash(chapter.url);
        const key = this.lastSegment(stripped);                 // chapter key
        const seriesUrl = stripped.slice(0, stripped.length - key.length - 1); // .../api/series/<slug>
        const slug = this.lastSegment(seriesUrl);

        const data = await this.getJson(this.withTrailingSlash(seriesUrl));
        const chapters = data.chapters || {};
        const chapterData = chapters[key];
        if (!chapterData) return [];

        const folder = chapterData.folder;
        const images = chapterData.groups || {};
        const groupKeys = Object.keys(images);
        if (!groupKeys.length) return [];
        const firstKey = groupKeys[0];
        const files = images[firstKey] || [];

        return files.map((file) => {
            const url = `https://${this.domain}${this.mediaPath}${slug}/chapters/${folder}/${firstKey}/${file}`;
            return new MangaPage({
                id: url,
                url,
                preview: null,
                source: this.source,
            });
        });
    }

    stripTrailingSlash(url) {
        return url.endsWith("/") ? url.slice(0, -1) : url;
    }

    lastSegment(url) {
        const clean = this.stripTrailingSlash(url);
        const i = clean.lastIndexOf("/");
        return i >= 0 ? clean.slice(i + 1) : clean;
    }
}
