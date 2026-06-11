/**
 * Base classes and types for Nyora Parsers (JavaScript)
 * Ported from Nyora (Kotlin)
 */

export const MangaState = {
    ONGOING: 'ONGOING',
    FINISHED: 'FINISHED',
    ABANDONED: 'ABANDONED',
    PAUSED: 'PAUSED',
    UPCOMING: 'UPCOMING',
};

export const SortOrder = {
    UPDATED: 'UPDATED',
    UPDATED_ASC: 'UPDATED_ASC',
    POPULARITY: 'POPULARITY',
    POPULARITY_ASC: 'POPULARITY_ASC',
    NEWEST: 'NEWEST',
    NEWEST_ASC: 'NEWEST_ASC',
    ALPHABETICAL: 'ALPHABETICAL',
    ALPHABETICAL_DESC: 'ALPHABETICAL_DESC',
    RATING: 'RATING',
    RATING_ASC: 'RATING_ASC',
    RELEVANCE: 'RELEVANCE',
};

export const ContentRating = {
    SAFE: 'SAFE',
    ADULT: 'ADULT',
};

/**
 * Canonical cross-platform manga/chapter id.
 *
 * MUST stay byte-identical to the native hashes (mac `generateNyoraId`, iOS `generateUid`)
 * so the SAME manga produces the SAME id on iOS / Android / Web / Linux / Mac — this is the
 * foundation of cross-device Supabase sync. Rule: seed 1125899906842597, then
 * `h = 31*h + <UTF-16 code unit>` iterated over (sourceName + url), wrapped to a signed
 * 64-bit integer each step, returned as a SIGNED decimal string (may be negative).
 *
 * The bundle owns id generation (see index.js stampIds) so every platform just trusts
 * `manga.id` / `chapter.id` and they can never diverge.
 */
export function nyoraId(sourceName, url) {
    let h = 1125899906842597n;
    const s = String(sourceName == null ? '' : sourceName) + String(url == null ? '' : url);
    for (let i = 0; i < s.length; i++) {
        h = BigInt.asIntN(64, h * 31n + BigInt(s.charCodeAt(i)));
    }
    return BigInt.asIntN(64, h).toString();
}

export class MangaSource {
    constructor(id, name, title, locale, domain) {
        this.id = id;
        this.name = name;
        this.title = title;
        this.locale = locale;
        this.domain = domain;
    }
}

export class Manga {
    constructor(data) {
        this.id = data.id;
        this.url = data.url;
        this.publicUrl = data.publicUrl;
        this.coverUrl = data.coverUrl;
        this.largeCoverUrl = data.largeCoverUrl || data.coverUrl;
        this.title = data.title;
        this.altTitles = data.altTitles || [];
        this.rating = data.rating || 0;
        this.tags = data.tags || [];
        this.authors = data.authors || [];
        this.state = data.state;
        this.source = data.source;
        this.contentRating = data.contentRating;
        this.isNsfw = data.isNsfw || data.contentRating === ContentRating.ADULT;
        this.description = data.description || "";
        this.chapters = data.chapters || [];
    }
}

export class MangaChapter {
    constructor(data) {
        this.id = data.id;
        this.url = data.url;
        this.title = data.title;
        this.number = data.number;
        this.volume = data.volume || 0;
        this.branch = data.branch;
        this.uploadDate = data.uploadDate || 0;
        this.scanlator = data.scanlator;
        this.source = data.source;
        this.pages = data.pages || [];
        this.index = data.index || 0;
    }
}

export class MangaPage {
    constructor(data) {
        this.id = data.id;
        this.url = data.url;
        this.preview = data.preview;
        this.source = data.source;
        this.headers = data.headers || {};
    }
}

export class BaseParser {
    constructor(context, source, domain, pageSize = 12) {
        this.context = context;
        this.source = source;
        this.domain = domain;
        this.pageSize = pageSize;
    }

    async getListPage(page, order, filter) { throw new Error("Not implemented"); }
    async getDetails(manga) { throw new Error("Not implemented"); }
    async getChapters(manga) { throw new Error("Not implemented"); }
    async getPages(chapter) { throw new Error("Not implemented"); }

    // Helpers
    toAbsoluteUrl(url) {
        if (!url) return "";
        if (url.startsWith("http")) return url;
        const base = this.domain.startsWith("http") ? this.domain : `https://${this.domain}`;
        return new URL(url, base).href;
    }

    toRelativeUrl(url) {
        if (!url) return "";
        if (!url.startsWith("http")) return url;
        try {
            const parsed = new URL(url);
            return parsed.pathname + parsed.search + parsed.hash;
        } catch {
            return url;
        }
    }
}
