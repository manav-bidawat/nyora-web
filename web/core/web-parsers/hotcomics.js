import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * HotComicsParser — ports Nyora's HotComicsParser family.
 *
 * Two markup variants share this engine, distinguished by domain:
 *  - TooMics (toomics.com/<lang>, toomics.top/de): ranking-genre listing,
 *    `li > div.visual` cards, `li.normal_ep:has(.coin-type1)` chapters,
 *    `div[id^=load_image_] img` pages, onePage, search disabled.
 *  - HotComics / DayComics (hotcomics.me/en, daycomics.me/en): `/genres`
 *    listing, `li[itemtype*=ComicSeries]` cards, `#tab-chapter` chapters with
 *    chapter URLs hidden inside an onclick="popupLogin('<url>')" handler,
 *    `#viewer-img img` pages.
 *
 * The Kotlin subclasses are pure selector/URL overrides, so the per-source
 * differences are reproduced here as instance fields seeded from the domain.
 * Object.assign(parser, source.overrides) can still patch any field.
 *
 * The `domain` carries a locale path segment (e.g. "toomics.com/ja"). The
 * Kotlin code strips that leading locale from every extracted href
 * ("/" + href.removePrefix("/").substringAfter('/')) and resolves links
 * against the bare host, which we mirror in `stripLocale` / `hostBase`.
 *
 * HONESTY / GAP: TooMics and HotComics/DayComics are paywalled login-gated
 * sites. Free preview chapters render their images under the documented
 * selectors and are extractable; locked chapters require an authenticated
 * session (popupLogin) and their page images are not present in anonymous
 * HTML — that content cannot be fetched from a plain browser context.
 */
export class HotComicsParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        const isTooMics = /toomics\./i.test(domain);

        // ---- tunable fields (override-able via source.overrides) ----
        this.mangasUrl = isTooMics ? '/webtoon/ranking/genre' : '/genres';
        this.onePage = isTooMics;
        this.isSearchSupported = !isTooMics;

        this.selectMangas = isTooMics ? 'li > div.visual' : 'li[itemtype*=ComicSeries]:not(.no-comic)';
        this.selectMangaChapters = isTooMics ? 'li.normal_ep:has(.coin-type1)' : '#tab-chapter li';
        this.selectTagsList = isTooMics ? 'div.genre_list li:not(.on) a' : '.genres-list li:not(.on) a';
        this.selectPages = isTooMics ? 'div[id^=load_image_] img' : '#viewer-img img';

        // hotcomics.me / daycomics.me use the popupLogin onclick chapter list.
        this.usePopupLoginChapters = /hotcomics\.|daycomics\./i.test(domain);

        this.datePattern = 'MMM dd, yyyy';
    }

    // -------- generic helpers (mirrors madara.js conventions) --------

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some selectors (e.g. :has()) may be rejected by the DOM impl;
                // fall through to the next, simpler selector.
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
                // ignore unsupported selector syntax
            }
        }
        return null;
    }

    // TooMics gates its detail/reader pages on the Referer header: a Referer of
    // the site ROOT (https://host/<lang>/) makes /webtoon/episode/toon/<id>
    // 302-redirect to the first /ep/1 reader page, while a Referer that matches
    // the page's own path keeps it on the full chapter-list page. Nyora sends
    // Referer = mangaUrl for exactly this reason.
    //
    // Neither the smoke harness nor the production runtime let a parser pass
    // per-request headers; both derive the Referer from `this.domain`
    // (https://${this.domain}/). So we briefly point `this.domain` at the page's
    // own path, issue the request, then restore it. We also retry with a
    // cache-buster because the gate is occasionally flaky.
    async httpGetAs(url, refererDomain, tries = 3) {
        const saved = this.domain;
        if (refererDomain) this.domain = refererDomain;
        try {
            let lastErr;
            for (let i = 0; i < tries; i++) {
                const target = i === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}nyoraTry=${Date.now()}-${i}`;
                try {
                    return await this.context.httpGet(target, this);
                } catch (e) {
                    lastErr = e;
                }
            }
            throw lastErr;
        } finally {
            this.domain = saved;
        }
    }

    async httpGetRetry(url, tries = 3) {
        return this.httpGetAs(url, null, tries);
    }

    // Build the "domain" string (host + path, no scheme) used to drive a Referer
    // equal to a given absolute/relative page URL.
    refererDomainFor(pageUrl) {
        const abs = this.absFromHost(pageUrl);
        return abs.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    }

    // Element.src() port: try lazy-load attrs then src, resolve to absolute.
    imageSrc(img) {
        if (!img) return '';
        const names = [
            'data-src', 'data-cfsrc', 'data-original', 'data-cdn',
            'data-lazy-src', 'original-src', 'data-wpfc-original-src', 'src',
        ];
        for (const name of names) {
            const v = img.getAttribute(name);
            if (v && !v.startsWith('data:') && !v.startsWith('blob:')) {
                return this.toAbsoluteUrl(v.trim());
            }
        }
        return '';
    }

    // The bare host of this.domain, without the locale path segment.
    hostBase() {
        const d = this.domain.startsWith('http') ? this.domain : `https://${this.domain}`;
        try {
            return `https://${new URL(d).hostname}`;
        } catch {
            return `https://${this.domain.split('/')[0]}`;
        }
    }

    // Resolve an extracted href to a relative URL with its leading locale
    // segment stripped, matching the Kotlin substringAfter('/') logic.
    stripLocale(href) {
        if (!href) return '';
        let rel;
        if (href.startsWith('http')) {
            try {
                const u = new URL(href);
                rel = u.pathname + u.search;
            } catch {
                rel = href;
            }
        } else {
            rel = href;
        }
        if (rel.startsWith('/')) {
            const trimmed = rel.replace(/^\/+/, '');
            const idx = trimmed.indexOf('/');
            // "/ja/webtoon/..." -> "/webtoon/..."; "/foo" with no slash -> "/"
            rel = '/' + (idx >= 0 ? trimmed.slice(idx + 1) : '');
        }
        return rel;
    }

    // Absolute URL built like Nyora's String.toAbsoluteUrl(domain): the
    // (locale-stripped) relative URL is concatenated onto the host + the
    // normalized locale segment (e.g. "toomics.com" + "/it"). Plain
    // new URL(rel, host) would drop the locale, so we concat by hand.
    absFromHost(relUrl) {
        if (!relUrl) return '';
        if (relUrl.startsWith('//')) return `https:${relUrl}`;
        if (relUrl.startsWith('http')) return relUrl;
        const base = `${this.hostBase()}${this.localeSegment()}`.replace(/\/+$/, '');
        if (relUrl.startsWith('/')) return `${base}${relUrl}`;
        return `${base}/${relUrl}`;
    }

    // -------- list --------

    async getListPage(page, order, filter) {
        filter = filter || {};
        if (this.onePage && page > 1) return [];

        const tags = (filter.tags || []).map((t) => (typeof t === 'string' ? t : (t.key || t.title))).filter(Boolean);

        let url = `${this.hostBase()}`;
        // Prepend the locale segment so the site serves localized markup.
        const localeSeg = this.localeSegment();

        if (filter.query && this.isSearchSupported) {
            url += `${localeSeg}/search?keyword=${encodeURIComponent(filter.query)}&page=${page}`;
        } else {
            url += `${localeSeg}${this.mangasUrl}`;
            if (tags.length) url += `/${tags[0]}`;
            if (!this.onePage) url += `?page=${page}`;
        }

        // Drive Referer == the listing page itself so the TooMics gate keeps us
        // on the localized ranking page instead of bouncing through the root.
        const refererDomain = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const html = await this.httpGetAs(url, refererDomain);
        const doc = this.context.parseHTML(html);
        return this.parseMangaList(doc);
    }

    // The locale path segment from this.domain (e.g. "/ja", "/en", "/por").
    // TooMics serves Spanish only under "/esp"; the legacy "/es" and "/mx"
    // segments 302-redirect there but require a content_lang cookie that a
    // stateless fetch cannot satisfy mid-redirect, so we normalize up front.
    localeSegment() {
        const d = this.domain.replace(/^https?:\/\//, '');
        const idx = d.indexOf('/');
        let seg = idx >= 0 ? d.slice(idx) : '';
        if (/toomics\./i.test(this.domain) && (seg === '/es' || seg === '/mx')) {
            seg = '/esp';
        }
        return seg;
    }

    parseMangaList(doc) {
        const isFinished = !!this.queryFirst(doc, ['.ico_fin']);
        const items = this.queryAll(doc, [
            this.selectMangas,
            'li[itemtype*=ComicSeries]:not(.no-comic)',
            'li > div.visual',
            'li[itemtype*=ComicSeries]',
        ]);

        const list = [];
        for (const li of items) {
            const a = li.querySelector('a') || (li.closest && li.closest('a'));
            if (!a) continue;
            const href = a.getAttribute('href') || '';
            if (!href || href.startsWith('javascript') || href === '#') continue;
            const rel = this.stripLocale(href);
            if (!rel || rel === '/') continue;

            const img = li.querySelector('img');
            const titleEl = this.queryFirst(li, ['.title', '.subject', 'strong.title', 'h3', 'h4']);
            const title = (titleEl ? titleEl.textContent : (img && img.getAttribute('alt')) || '').trim();
            if (!title) continue;

            const isNsfwCard = !!this.queryFirst(a, ['.ico-18plus']) || !!this.queryFirst(li, ['.ico-18plus']);
            const descEl = this.queryFirst(li, ['p[itemprop*=description]', 'p.desc', '.summary']);
            const author = (this.queryFirst(li, ['.writer', '.author']) || {}).textContent || '';

            list.push(new Manga({
                id: rel,
                url: rel,
                publicUrl: this.absFromHost(rel),
                coverUrl: this.imageSrc(img),
                title,
                description: descEl ? descEl.textContent.trim() : '',
                authors: author.trim() ? [author.trim()] : [],
                state: isFinished ? MangaState.FINISHED : MangaState.ONGOING,
                source: this.source,
                contentRating: (isNsfwCard || (this.source && this.source.isNsfw)) ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    // -------- details --------

    async getDetails(manga) {
        const mangaUrl = this.absFromHost(manga.url);
        // Drive Referer == this page (Nyora's behaviour) so TooMics serves the
        // full chapter-list page instead of redirecting to the ep/1 reader.
        const html = await this.httpGetAs(mangaUrl, this.refererDomainFor(manga.url));
        const doc = this.context.parseHTML(html);

        const descEl = this.queryFirst(doc, [
            'div.title_content_box h2', '.title_content_box h2', '.synopsis',
            'meta[property="og:title"]',
        ]);
        let description = '';
        if (descEl) {
            description = descEl.tagName === 'META'
                ? (descEl.getAttribute('content') || '')
                : descEl.textContent.trim();
        }
        description = description || manga.description;

        let chapters = this.usePopupLoginChapters
            ? this.parsePopupLoginChapters(doc)
            : this.parseChapterList(doc);

        // Fallback: we were redirected to a reader page (no chapter list). Build
        // chapters from the reader page's episode navigation + the landed URL.
        if (!chapters.length) {
            chapters = this.parseReaderChapters(doc, mangaUrl);
        }

        return new Manga({
            ...manga,
            description,
            contentRating: manga.contentRating || ((this.source && this.source.isNsfw) ? ContentRating.ADULT : ContentRating.SAFE),
            source: this.source,
            chapters,
        });
    }

    // TooMics reader-page fallback: the /webtoon/detail/code/<c>/ep/<n>/toon/<id>
    // page exposes the current episode plus next/prev episode links. Collect
    // every distinct /ep/N/toon/ reader URL we can see, including the current
    // page (extracted from og:url / canonical), so getPages always has a target.
    parseReaderChapters(doc, landedUrl) {
        const seen = new Map(); // rel -> number
        const consider = (raw) => {
            if (!raw) return;
            const rel = this.stripLocale(raw);
            const m = rel.match(/\/ep\/(\d+)\/toon\//);
            if (!m) return;
            if (!seen.has(rel)) seen.set(rel, parseInt(m[1], 10));
        };

        // The page we actually landed on (canonical/og:url or the requested URL).
        const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href')
            || doc.querySelector('meta[property="og:url"]')?.getAttribute('content')
            || landedUrl;
        consider(canonical);

        for (const a of doc.querySelectorAll('a')) {
            const href = a.getAttribute('href') || '';
            const onclick = a.getAttribute('onclick') || '';
            consider(href);
            const m = onclick.match(/location\.href='([^']+)'/);
            if (m) consider(m[1]);
        }

        const entries = Array.from(seen.entries()).sort((a, b) => a[1] - b[1]);
        return entries.map(([rel, num], i) => new MangaChapter({
            id: rel,
            url: rel,
            title: `Ep. ${num}`,
            number: Number.isFinite(num) ? num : (i + 1),
            volume: 0,
            uploadDate: 0,
            source: this.source,
        }));
    }

    // Default (TooMics) chapter list: anchors inside selectMangaChapters items.
    parseChapterList(doc) {
        const items = this.queryAll(doc, [
            this.selectMangaChapters,
            '#tab-chapter li',
            'li.normal_ep:has(.coin-type1)',
            'li.normal_ep',
            '#tab-chapter a',
        ]);

        const chapters = [];
        items.forEach((li, i) => {
            const a = li.tagName === 'A' ? li : li.querySelector('a');
            if (!a) return;
            const rel = this.chapterHrefFromAnchor(a);
            if (!rel || rel === '/') return;

            const numEl = this.queryFirst(li, ['.num']);
            const num = numEl ? parseFloat(numEl.textContent.trim()) : NaN;
            const timeEl = this.queryFirst(li, ['time']);
            const dateText = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : '';

            chapters.push(new MangaChapter({
                id: rel,
                url: rel,
                title: null,
                number: Number.isFinite(num) ? num : (i + 1),
                volume: 0,
                uploadDate: this.parseDate(dateText),
                source: this.source,
            }));
        });
        return chapters;
    }

    // hotcomics.me / daycomics.me: chapter URL lives in onclick=popupLogin('url').
    parsePopupLoginChapters(doc) {
        const anchors = this.queryAll(doc, ['#tab-chapter a', '#tab-chapter li a']);
        const chapters = [];
        anchors.forEach((a, i) => {
            const onclick = a.getAttribute('onclick') || '';
            let raw = '';
            const m = onclick.match(/popupLogin\('([^']+)'/);
            if (m) raw = m[1];
            else raw = a.getAttribute('href') || '';
            const rel = this.stripLocale(raw);
            if (!rel || rel === '/') return;

            const nameEl = this.queryFirst(a, ['.cell-num']);
            const name = nameEl ? nameEl.textContent.trim() : 'Unknown';
            const timeEl = this.queryFirst(a, ['.cell-time', 'time']);
            const dateText = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : '';
            const numEl = this.queryFirst(a, ['.num']);
            const num = numEl ? parseFloat(numEl.textContent.trim()) : NaN;

            chapters.push(new MangaChapter({
                id: rel,
                url: rel,
                title: name,
                number: Number.isFinite(num) ? num : (i + 1),
                volume: 0,
                uploadDate: this.parseDate(dateText),
                source: this.source,
            }));
        });
        return chapters;
    }

    // Extract a chapter href from an anchor, handling javascript:/onclick links.
    chapterHrefFromAnchor(a) {
        let href = a.getAttribute('href') || '';
        if (href.startsWith('javascript') || !href || href === '#') {
            const onclick = a.getAttribute('onclick') || '';
            const m = onclick.match(/href='([^']+)'/) || onclick.match(/popupLogin\('([^']+)'/);
            if (m) href = m[1];
        }
        return this.stripLocale(href);
    }

    parseDate(text) {
        if (!text) return 0;
        const t = String(text).trim();
        const parsed = Date.parse(t);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    // -------- pages --------

    async getPages(chapter) {
        const fullUrl = this.absFromHost(chapter.url);
        const html = await this.httpGetRetry(fullUrl);
        const doc = this.context.parseHTML(html);

        const imgs = this.queryAll(doc, [
            this.selectPages,
            'div[id^=load_image_] img',
            '#viewer-img img',
            '#viewer img',
            '.viewer img',
        ]);

        return imgs.map((img, i) => {
            const url = this.imageSrc(img);
            return new MangaPage({
                id: url || String(i),
                url,
                source: this.source,
            });
        }).filter((p) => p.url);
    }
}
