import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangAdventure family parser.
 *
 * MangAdventure is a free/open-source Django manga reader CMS. Unlike most
 * Nyora sources it is NOT HTML-scraped: every read path goes through the
 * site's public JSON API mounted at `/api/v2`. We port that behavior directly.
 *
 *   list     GET /api/v2/series?limit&page&title&categories&status&sort
 *   details  GET /api/v2/series/{slug}
 *   chapters GET /api/v2/series/{slug}/chapters?date_format=timestamp
 *   pages    GET /api/v2/chapters/{id}/pages?track=true
 *   tags     GET /api/v2/categories
 *
 * Reference Kotlin: site/mangadventure/MangAdventureParser.kt
 *
 * Concrete sources (key "mangadventure"): ARCRELIGHT (arc-relight.com),
 * ASSORTEDSCANS (assortedscans.com). Both expose the same API; per-source
 * differences in the Kotlin (related-manga franchises, empty-tag filtering)
 * do not affect list/details/pages, so no overrides are required here. All
 * tunables are still instance fields so a source descriptor can patch them.
 */
export class MangAdventureParser extends BaseParser {
    constructor(context, source, domain, pageSize = 25) {
        super(context, source, domain, pageSize);
        // API surface — every fragment is an instance field so per-source
        // `overrides` can patch it via Object.assign.
        this.apiPath = "api/v2";
        this.seriesPath = "series";
        this.chaptersPath = "chapters";
        this.pagesPath = "pages";
        this.categoriesPath = "categories";
        // Reader URLs look like `/reader/{slug}/`. We strip this prefix to
        // recover the slug used in API paths.
        this.readerPrefix = "/reader/";
    }

    apiUrl(...segments) {
        const base = this.domain.startsWith("http") ? this.domain : `https://${this.domain}`;
        const path = [this.apiPath, ...segments]
            .filter((s) => s !== undefined && s !== null && s !== "")
            .map((s) => String(s).replace(/^\/+|\/+$/g, ""))
            .join("/");
        return `${base.replace(/\/+$/, "")}/${path}`;
    }

    async getJson(url) {
        const text = await this.context.httpGet(url, this);
        return JSON.parse(text);
    }

    // Recover the API slug from a manga url like `/reader/arc-light/`.
    slugOf(manga) {
        let url = manga && manga.url ? String(manga.url) : "";
        if (manga && manga.slug) return manga.slug;
        // Strip a leading domain if a full URL slipped through.
        url = this.toRelativeUrl(url);
        if (url.startsWith(this.readerPrefix)) {
            url = url.slice(this.readerPrefix.length);
        } else {
            url = url.replace(/^\/+/, "");
        }
        return url.replace(/\/+$/, "");
    }

    sortParam(order) {
        switch (order) {
            case SortOrder.ALPHABETICAL: return "title";
            case SortOrder.ALPHABETICAL_DESC: return "-title";
            case SortOrder.UPDATED: return "-latest_upload";
            case SortOrder.POPULARITY: return "-views";
            default: return "-latest_upload";
        }
    }

    statusParam(state) {
        switch (state) {
            case MangaState.ONGOING: return "ongoing";
            case MangaState.FINISHED: return "completed";
            case MangaState.ABANDONED: return "canceled";
            case MangaState.PAUSED: return "hiatus";
            default: return "any";
        }
    }

    mapState(status) {
        switch (String(status || "").toLowerCase()) {
            case "ongoing": return MangaState.ONGOING;
            case "completed": return MangaState.FINISHED;
            case "canceled": return MangaState.ABANDONED;
            case "hiatus": return MangaState.PAUSED;
            default: return undefined;
        }
    }

    get contentRating() {
        return (this.source && this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE;
    }

    // Build a Manga from a `results[]` entry of the series listing/search.
    mangaFromJson(it) {
        // Licensed series have `chapters: null` and cannot be read — skip them.
        if (it == null || it.chapters === null) return null;
        const path = it.url || (`${this.readerPrefix}${it.slug}/`);
        return new Manga({
            id: path,
            url: path,
            slug: it.slug,
            publicUrl: this.toAbsoluteUrl(path),
            coverUrl: it.cover || "",
            largeCoverUrl: it.cover || "",
            title: it.title || "",
            source: this.source,
            contentRating: this.contentRating,
        });
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        const params = new URLSearchParams();
        params.set("limit", String(this.pageSize));
        params.set("page", String(page));

        if (filter.query) params.set("title", filter.query);

        // categories: `inc1,inc2,,-exc1,-exc2` (note the trailing comma after
        // includes even when there are no excludes — matches the Kotlin).
        const tags = Array.isArray(filter.tags) ? filter.tags : [];
        const tagsExclude = Array.isArray(filter.tagsExclude) ? filter.tagsExclude : [];
        if (tags.length || tagsExclude.length) {
            const inc = tags.map((t) => t.key).join(",");
            const exc = tagsExclude.map((t) => `-${t.key}`).join(",");
            params.set("categories", `${inc},${exc}`);
        }

        const states = Array.isArray(filter.states) ? filter.states : [];
        if (states.length === 1) {
            params.set("status", this.statusParam(states[0]));
        }

        params.set("sort", this.sortParam(order));

        let json;
        try {
            json = await this.getJson(`${this.apiUrl(this.seriesPath)}?${params.toString()}`);
        } catch (e) {
            // The Kotlin treats 404 as an empty page (paged-past-the-end).
            if (/HTTP\s*404/.test(String(e && e.message))) return [];
            throw e;
        }
        const results = (json && Array.isArray(json.results)) ? json.results : [];
        return results.map((it) => this.mangaFromJson(it)).filter(Boolean);
    }

    async getDetails(manga) {
        const slug = this.slugOf(manga);
        const seriesUrl = `${this.apiUrl(this.seriesPath, slug)}`;
        const chaptersUrl = `${this.apiUrl(this.seriesPath, slug, this.chaptersPath)}?date_format=timestamp`;

        const details = await this.getJson(seriesUrl);
        let chaptersJson = { results: [] };
        try {
            chaptersJson = await this.getJson(chaptersUrl);
        } catch {
            chaptersJson = { results: [] };
        }

        const authors = Array.isArray(details.authors) ? details.authors : [];
        const artists = Array.isArray(details.artists) ? details.artists : [];
        // Kotlin builds a single combined author string; we keep them as a list.
        const allAuthors = [...authors, ...artists].filter(Boolean);

        const categories = Array.isArray(details.categories) ? details.categories : [];
        const tags = categories.map((name) => ({ title: name, key: name }));

        const aliases = Array.isArray(details.aliases) ? details.aliases : [];

        // Chapters come newest-first from the API; emit oldest-first.
        const rawChapters = (chaptersJson && Array.isArray(chaptersJson.results)) ? chaptersJson.results.slice() : [];
        rawChapters.reverse();
        const chapters = rawChapters.map((it, i) => {
            const groups = Array.isArray(it.groups) ? it.groups.filter(Boolean) : [];
            const published = it.published != null ? Number(it.published) : 0;
            return new MangaChapter({
                // API chapter id is required to fetch pages — keep it numeric.
                id: it.id,
                url: it.url,
                title: it.full_title || it.title || "",
                number: typeof it.number === "number" ? it.number : (parseFloat(it.number) || 0),
                volume: it.volume != null ? (parseInt(it.volume, 10) || 0) : 0,
                branch: null,
                scanlator: groups.join(", "),
                uploadDate: Number.isFinite(published) ? published : 0,
                index: i,
                source: this.source,
            });
        });

        return new Manga({
            ...manga,
            title: details.title || manga.title,
            slug,
            description: details.description || "",
            altTitles: aliases,
            authors: allAuthors,
            tags,
            coverUrl: details.cover || manga.coverUrl || "",
            largeCoverUrl: details.cover || manga.largeCoverUrl || manga.coverUrl || "",
            state: this.mapState(details.status),
            contentRating: this.contentRating,
            source: this.source,
            chapters,
        });
    }

    async getPages(chapter) {
        // chapter.id is the numeric API id captured in getDetails. Fall back to
        // an id embedded in the reader url (/reader/{slug}/{vol}/{num}/) only if
        // the numeric id is missing — the API needs the numeric chapter id, so
        // there is no reliable fallback when it is absent.
        const id = chapter && chapter.id;
        if (id == null || id === "") return [];
        const url = `${this.apiUrl(this.chaptersPath, id, this.pagesPath)}?track=true`;
        let json;
        try {
            json = await this.getJson(url);
        } catch {
            return [];
        }
        const results = (json && Array.isArray(json.results)) ? json.results : [];
        return results.map((it) => new MangaPage({
            id: it.image || String(it.id),
            url: it.image,
            preview: null,
            source: this.source,
        })).filter((p) => p.url);
    }

    // Optional: category list, exposed in case the client wants tag filters.
    async getTags() {
        try {
            const json = await this.getJson(this.apiUrl(this.categoriesPath));
            const results = (json && Array.isArray(json.results)) ? json.results : [];
            return results.map((it) => ({ title: it.name, key: it.name }));
        } catch {
            return [];
        }
    }
}
