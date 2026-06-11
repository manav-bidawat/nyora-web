import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * PizzaReader CMS parser family (key "pizzareader").
 *
 * Ported from Nyora's PizzaReaderParser (SinglePageMangaParser). Unlike most
 * Nyora sources this is NOT an HTML scraper: every PizzaReader site exposes a
 * JSON REST API rooted at `/api`:
 *   - GET /api/comics                -> { comics: [ {title, url, thumbnail, ...} ] }   (full catalog, one page)
 *   - GET /api/search/<query>        -> { comics: [...] }
 *   - GET /api<comic.url>            -> { comic: { ..., genres:[], chapters:[] } }
 *   - GET /api<chapter.url>          -> { chapter: { ..., pages: [imageUrl, ...] } }
 *
 * Comic/chapter `url` fields are returned WITHOUT the `/api` prefix (e.g.
 * "/comics/foo", "/read/foo/it/ch/4"); the API is reached by prefixing "/api".
 * We therefore store manga/chapter ids as the `/api...` path so getDetails /
 * getPages can hit the JSON endpoint directly.
 *
 * Everything this family needs (catalog, search, details, pages) is plain JSON
 * over fetch — no encryption, no JS VM, no Cloudflare challenge. Fully tractable
 * in a browser/fetch context.
 *
 * 8 concrete sources: GTOTHEGREATSITE, LUPITEAM, PHOENIXSCANS, HASTATEAM,
 * TUTTOANIMEMANGA, HASTATEAM_READER, FMTEAM, HNISCANTRAD.
 */
export class PizzaReaderParser extends BaseParser {
    constructor(context, source, domain, pageSize = 9999) {
        // PizzaReader returns the WHOLE catalog in a single /api/comics call
        // (SinglePageMangaParser upstream), so there is effectively one page.
        super(context, source, domain, pageSize);

        // API path fragments (instance fields so per-source overrides can patch).
        this.apiPrefix = "/api";
        this.comicsPath = "/api/comics";
        this.searchPath = "/api/search/"; // + urlEncoded query

        // Date format produced by the API: ISO-8601 "2021-02-13T23:26:49.000000Z".
        // Parsed via Date.parse (handles the trailing Z); microseconds are tolerated.

        // Status-string buckets used to map the free-text `status` field to a
        // MangaState. Lowercased comparison. Mirrors the Kotlin sets.
        this.ongoing = new Set([
            "en cours",
            "in corso",
            "in corso (cadenza irregolare)",
            "in corso (irregolare)",
            "in corso (mensile)",
            "in corso (quindicinale)",
            "in corso (settimanale)",
            "in corso (bisettimanale)",
        ]);
        this.finished = new Set([
            "terminé",
            "concluso",
            "completato",
        ]);
        this.paused = new Set([
            "in pausa",
            "in corso (in pausa)",
        ]);
        this.abandoned = new Set([
            "droppato",
        ]);

        // Substring filters used when the caller requests a specific state
        // (per-source overridable, e.g. FmTeam/HniScantrad use French).
        this.ongoingFilter = "in corso";
        this.completedFilter = "concluso";
        this.hiatusFilter = "in pausa";
        this.abandonedFilter = "droppato";
    }

    async getJson(url) {
        const text = await this.context.httpGet(url, this);
        return JSON.parse(text);
    }

    parseDate(value) {
        if (!value) return 0;
        const t = Date.parse(value);
        return Number.isNaN(t) ? 0 : t;
    }

    mapState(statusRaw) {
        const status = String(statusRaw || "").toLowerCase();
        if (this.ongoing.has(status)) return MangaState.ONGOING;
        if (this.finished.has(status)) return MangaState.FINISHED;
        if (this.paused.has(status)) return MangaState.PAUSED;
        if (this.abandoned.has(status)) return MangaState.ABANDONED;
        return undefined;
    }

    // Build a Manga from a catalog/search JSON object. The `url` field from the
    // API lacks the `/api` prefix; we store the `/api...` path as id/url so
    // getDetails can fetch the JSON endpoint directly.
    buildManga(j) {
        const apiUrl = this.apiPrefix + (j.url || "");
        const adult = Number(j.adult);
        const isNsfw = adult === 0 ? false : true; // anything not 0 treated as adult, per Kotlin
        const author = j.author;
        const rating = (() => {
            const r = parseFloat(j.rating);
            return Number.isNaN(r) ? 0 : r / 10;
        })();
        let altTitles = [];
        if (Array.isArray(j.alt_titles)) altTitles = j.alt_titles.filter(Boolean);
        return new Manga({
            id: apiUrl,
            url: apiUrl,
            publicUrl: this.toAbsoluteUrl(j.url || apiUrl),
            coverUrl: j.thumbnail || j.thumbnail_small || "",
            largeCoverUrl: j.thumbnail || j.thumbnail_small || "",
            title: j.title || "",
            altTitles,
            description: j.description || "",
            rating,
            tags: Array.isArray(j.genres)
                ? j.genres.filter(Boolean).map((g) => ({ key: g.slug || g.name, title: g.name }))
                : [],
            authors: author ? [author] : [],
            state: this.mapState(j.status),
            source: this.source,
            isNsfw,
            contentRating: isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        });
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        // The whole catalog comes back in one request; only the first page has data.
        if (page && page > 1 && !filter.query) return [];

        let comics = [];
        if (filter.query) {
            const data = await this.getJson(`https://${this.domain}${this.searchPath}${encodeURIComponent(filter.query)}`);
            comics = Array.isArray(data.comics) ? data.comics : [];
        } else {
            const data = await this.getJson(`https://${this.domain}${this.comicsPath}`);
            comics = Array.isArray(data.comics) ? data.comics : [];
        }

        const tags = (filter.tags || []).map((t) => String(t.key || t.title || t).toLowerCase()).filter(Boolean);
        const tagsExclude = (filter.tagsExclude || []).map((t) => String(t.key || t.title || t).toLowerCase()).filter(Boolean);
        const states = filter.states || [];

        const result = [];
        for (const j of comics) {
            // Client-side filtering mirrors the Kotlin getList (the API has no
            // server-side tag/state filters). Skipped entirely for search.
            if (!filter.query) {
                if (tags.length) {
                    const genreStr = JSON.stringify(j.genres || []).toLowerCase();
                    if (!tags.some((k) => genreStr.includes(k))) continue;
                }
                if (tagsExclude.length) {
                    const genreStr = JSON.stringify(j.genres || []).toLowerCase();
                    // Kotlin keeps the manga if ANY excluded tag is absent (its
                    // own quirk); reproduce that behavior to match upstream.
                    if (!tagsExclude.some((k) => !genreStr.includes(k))) continue;
                }
                if (states.length === 1) {
                    const statusStr = String(j.status || "").toLowerCase();
                    const want = states[0];
                    let frag = "";
                    if (want === MangaState.PAUSED) frag = this.hiatusFilter;
                    else if (want === MangaState.ONGOING) frag = this.ongoingFilter;
                    else if (want === MangaState.FINISHED) frag = this.completedFilter;
                    else if (want === MangaState.ABANDONED) frag = this.abandonedFilter;
                    if (frag && !statusStr.includes(frag.toLowerCase())) continue;
                }
            }
            result.push(this.buildManga(j));
        }
        return result;
    }

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const data = await this.getJson(fullUrl);
        const comic = data.comic || {};

        const tags = Array.isArray(comic.genres)
            ? comic.genres.filter(Boolean).map((g) => ({ key: g.slug || g.name, title: g.name }))
            : manga.tags;

        // API returns chapters newest-first; Nyora wants oldest-first.
        const rawChapters = Array.isArray(comic.chapters) ? comic.chapters.slice().reverse() : [];
        const chapters = rawChapters.map((j, i) => {
            const apiUrl = this.apiPrefix + (j.url || "");
            return new MangaChapter({
                id: apiUrl,
                url: apiUrl,
                title: j.full_title || j.title || "",
                number: i + 1,
                volume: Number(j.volume) || 0,
                branch: null,
                uploadDate: this.parseDate(j.updated_at || j.published_on),
                scanlator: Array.isArray(j.teams) && j.teams.length
                    ? j.teams.map((t) => (t && (t.name || (typeof t === "string" ? t : ""))) || "").filter(Boolean).join(", ") || null
                    : null,
                source: this.source,
                index: i,
            });
        });

        return new Manga({
            ...manga,
            title: comic.title || manga.title,
            description: comic.description || manga.description,
            coverUrl: comic.thumbnail || manga.coverUrl,
            largeCoverUrl: comic.thumbnail || manga.largeCoverUrl || manga.coverUrl,
            tags,
            chapters,
        });
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const data = await this.getJson(fullUrl);
        const ch = data.chapter || {};
        const pages = Array.isArray(ch.pages) ? ch.pages : [];
        // NOTE: the Kotlin port re-serializes the pages array and string-splits
        // it, then `.drop(1)` — that drops the first page (an upstream bug from
        // the JSON.stringify/split round-trip). We read the JSON array directly
        // so every page is included.
        return pages
            .filter(Boolean)
            .map((url, i) => new MangaPage({
                id: url,
                url: this.toAbsoluteUrl(url),
                preview: null,
                source: this.source,
            }));
    }
}
