import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * ComicasoParser — port of Nyora's ComicasoParser (key "comicaso").
 *
 * This family is a static-JSON driven WordPress theme. The site ships a global
 * catalogue at  /wp-content/static/manga/index.json  (an array of manga DTOs)
 * and a per-manga document at  /wp-content/static/manga/<slug>.json  (full
 * metadata + chapter list). Listing, search, tag/state/type filtering and
 * sorting are all done client-side over index.json — exactly like the Kotlin
 * parser. There are NO server-side list/search/ajax endpoints.
 *
 * Page images, however, only exist on the rendered chapter HTML reader
 * (<img class="mjv2-page-image">). On at least some live members (comicazen.com)
 * that reader path sits behind a Cloudflare "Just a moment..." JS challenge,
 * which a plain fetch + DOMParser cannot solve. getPages() is ported faithfully
 * and works wherever the challenge is absent or solved upstream (real browser /
 * challenge-solving proxy); see the gap note in getPages().
 */
export class ComicasoParser extends BaseParser {
    constructor(context, source, domain, pageSize = 16) {
        super(context, source, domain, pageSize);

        // --- tunable fields (per-source `overrides` can Object.assign these) ---
        this.sourceLocale = 'id';
        // Static catalogue / detail document paths.
        this.indexPath = '/wp-content/static/manga/index.json';
        this.detailPathPrefix = '/wp-content/static/manga/';
        this.detailPathSuffix = '.json';
        // URL shape for a manga / chapter on the live site.
        this.mangaUrlPrefix = '/komik/';
        // Page-image selectors on the chapter reader page.
        this.pageImageSelectors = [
            'img.mjv2-page-image',
            '#readerarea img',
            'div.reading-content img',
            '.read-container img',
            'img.wp-manga-chapter-img',
        ];
        // Status string -> MangaState mapping (matches the Kotlin parser).
        this.statusOngoing = 'on-going';
        this.statusFinished = 'end';

        // In-memory cache of the parsed index.json (mirrors the Kotlin Mutex cache).
        this._mangaIndexCache = null;
    }

    // --- helpers (madara.js conventions) -----------------------------------

    imageSrc(img) {
        const url = img ? (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src') || '') : '';
        if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url || '';
        return this.toAbsoluteUrl(url);
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to the next selector shape.
            }
        }
        return [];
    }

    _baseUrl() {
        return this.domain.startsWith('http') ? this.domain : `https://${this.domain}`;
    }

    _toTitleCase(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    _stateFromStatus(status) {
        switch (status) {
            case this.statusOngoing: return MangaState.ONGOING;
            case this.statusFinished: return MangaState.FINISHED;
            default: return undefined;
        }
    }

    _contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    _genreTags(genres) {
        if (!Array.isArray(genres)) return [];
        return genres.filter(Boolean).map((g) => ({
            key: String(g).toLowerCase(),
            title: this._toTitleCase(g),
            source: this.source,
        }));
    }

    _extractChapterNumber(title) {
        const m = String(title || '').match(/[\d]+(?:[.,]\d+)?/);
        if (!m) return 0;
        return parseFloat(m[0].replace(',', '.')) || 0;
    }

    // --- index.json (catalogue) caching ------------------------------------

    async _getMangaIndex() {
        if (this._mangaIndexCache) return this._mangaIndexCache;
        const url = `${this._baseUrl()}${this.indexPath}`;
        const text = await this.context.httpGet(url, this);
        let arr;
        try {
            arr = JSON.parse(text);
        } catch {
            arr = [];
        }
        this._mangaIndexCache = Array.isArray(arr) ? arr : [];
        return this._mangaIndexCache;
    }

    _dtoToManga(jo) {
        const slug = jo.slug;
        const relUrl = `${this.mangaUrlPrefix}${slug}/`;
        return new Manga({
            id: relUrl,
            url: relUrl,
            publicUrl: `${this._baseUrl()}${relUrl}`,
            coverUrl: jo.thumbnail || '',
            largeCoverUrl: jo.thumbnail || '',
            title: jo.title || '',
            altTitles: jo.alternative ? [jo.alternative] : [],
            tags: this._genreTags(jo.genres),
            authors: [jo.author, jo.artist].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i),
            state: this._stateFromStatus(jo.status),
            source: this.source,
            contentRating: this._contentRating(),
        });
    }

    // --- list / search / filter / sort -------------------------------------

    async getListPage(page, order, filter = {}) {
        let list = await this._getMangaIndex();

        // Filter by query (substring, case-insensitive over title).
        if (filter.query) {
            const q = String(filter.query).toLowerCase();
            list = list.filter((it) => String(it.title || '').toLowerCase().includes(q));
        }

        // Filter by a single tag (key == lowercased genre).
        const tag = filter.tags && filter.tags.length ? filter.tags[0] : null;
        if (tag) {
            const tagKey = String(tag.key || tag).toLowerCase();
            list = list.filter((dto) => Array.isArray(dto.genres) &&
                dto.genres.some((g) => String(g).toLowerCase() === tagKey));
        }

        // Filter by a single state.
        const state = filter.states && filter.states.length ? filter.states[0] : null;
        if (state) {
            let statusStr = null;
            if (state === MangaState.ONGOING) statusStr = this.statusOngoing;
            else if (state === MangaState.FINISHED) statusStr = this.statusFinished;
            if (statusStr) list = list.filter((it) => it.status === statusStr);
        }

        // Filter by a single content type (manga / manhwa / manhua).
        const type = filter.types && filter.types.length ? filter.types[0] : null;
        if (type) {
            const typeStr = String(type).toLowerCase();
            if (typeStr === 'manga' || typeStr === 'manhwa' || typeStr === 'manhua') {
                list = list.filter((it) => String(it.type || '').toLowerCase() === typeStr);
            }
        }

        // Sort (default POPULARITY == native index.json order).
        if (order === SortOrder.UPDATED) {
            list = [...list].sort((a, b) =>
                ((b.updated_at || b.manga_date || 0) - (a.updated_at || a.manga_date || 0)));
        } else if (order === SortOrder.ALPHABETICAL) {
            list = [...list].sort((a, b) =>
                String(a.title || '').toLowerCase().localeCompare(String(b.title || '').toLowerCase()));
        }

        // Manual pagination (smoke harness passes page 1).
        const start = (page - 1) * this.pageSize;
        if (start >= list.length) return [];
        const end = Math.min(start + this.pageSize, list.length);
        return list.slice(start, end).map((dto) => this._dtoToManga(dto));
    }

    // --- details (per-manga JSON document) ---------------------------------

    async getDetails(manga) {
        const slug = String(manga.url || '')
            .replace(this.mangaUrlPrefix, '')
            .replace(/\/$/, '');
        const url = `${this._baseUrl()}${this.detailPathPrefix}${slug}${this.detailPathSuffix}`;
        const text = await this.context.httpGet(url, this);
        const json = JSON.parse(text);

        const synopsis = (json.synopsis || '').trim();
        const alternative = (json.alternative || '').trim();
        let description = '';
        if (synopsis) description += synopsis;
        if (alternative) {
            if (description) description += '\n\n';
            description += `Alternative: ${alternative}`;
        }
        description = description.trim();

        const tags = this._genreTags(json.genres);
        const authors = [json.author, json.artist]
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i);

        const chArr = Array.isArray(json.chapters) ? json.chapters : [];
        const chapters = chArr.map((ch) => {
            const chSlug = ch.slug;
            const chTitle = ch.title || '';
            const relUrl = `${this.mangaUrlPrefix}${slug}/${chSlug}/`;
            const date = ch.date ? Number(ch.date) * 1000 : 0;
            return new MangaChapter({
                id: relUrl,
                url: relUrl,
                title: chTitle,
                number: this._extractChapterNumber(chTitle),
                volume: 0,
                uploadDate: date,
                scanlator: null,
                branch: null,
                source: this.source,
            });
        });
        // index.json lists newest-first; Nyora/Nyora want oldest-first.
        chapters.reverse();

        return new Manga({
            ...manga,
            title: json.title || manga.title,
            description: description || manga.description,
            coverUrl: json.thumbnail || manga.coverUrl,
            largeCoverUrl: json.thumbnail || manga.largeCoverUrl || manga.coverUrl,
            altTitles: alternative ? [alternative] : manga.altTitles,
            tags,
            state: this._stateFromStatus(json.status) ?? manga.state,
            authors,
            source: this.source,
            contentRating: this._contentRating(),
            chapters,
        });
    }

    // --- pages (chapter reader HTML) ---------------------------------------

    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);

        // GAP: on live members such as comicazen.com the chapter reader path is
        // protected by a Cloudflare "Just a moment..." JS challenge. The static
        // catalogue (index.json) and per-manga detail JSON are NOT challenged, so
        // list + details work fully, but the page images live ONLY on this gated
        // HTML page (no page-image JSON endpoint exists). A plain fetch + DOMParser
        // cannot solve that challenge, so getPages returns [] for challenged
        // responses. It extracts pages correctly whenever the challenge is absent
        // or already solved upstream (real browser / challenge-solving proxy).
        if (html.includes('Just a moment') || html.includes('challenges.cloudflare.com')) {
            return [];
        }

        const doc = this.context.parseHTML(html);
        const images = this.queryAll(doc, this.pageImageSelectors);
        return images.map((img) => {
            const imageUrl = this.imageSrc(img);
            return new MangaPage({
                id: imageUrl,
                url: imageUrl,
                source: this.source,
            });
        }).filter((p) => p.url);
    }
}
