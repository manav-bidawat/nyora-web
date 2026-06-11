import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * UzayMangaParser — ports the Nyora UzayMangaParser family (key "uzaymanga").
 * Concrete sources: UZAYMANGA (uzaymanga.com), TENSHIMANGA (tenshimanga.com).
 *
 * The live sites are SvelteKit single-page apps. The `/search` route is rendered
 * entirely client-side (a plain fetch of `/search` returns a 404 SSR shell), so the
 * Kotlin parser's `div.card` / `section[series area]` selectors never see content
 * without a real browser. Instead we read SvelteKit's data endpoints, which serve
 * the same data the app hydrates from over plain HTTP:
 *   - GET /__data.json                          -> homepage data (popular/latest/new lists)
 *   - GET /manga/<slug>/__data.json             -> series detail + SeriesEpisode list
 *   - GET /manga/<slug>/<episode>/__data.json   -> episode.images (page paths)
 * Page/cover images live on a separate CDN (PUBLIC_CDN_URL, embedded in the SSR HTML),
 * so we auto-detect that origin and prefix the relative image paths with it.
 *
 * Each tunable (date pattern, status map, CDN url, selectors) is an instance field
 * so per-source `overrides` can patch it via Object.assign.
 */
export class UzayMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // Per-source CDN base. Auto-detected from the homepage SSR HTML on first use;
        // these are sane fallbacks if detection fails. The Kotlin values are stale.
        this.cdnUrl = domain === 'tenshimanga.com'
            ? 'https://cdn-t.efsaneler2.can.re'
            : (domain === 'uzaymanga.com' ? 'https://cdn-u.efsaneler2.can.re' : null);
        this._cdnResolved = false;

        // Turkish month names used in chapter dates ("Oca 5 ,2024"). Best-effort only.
        this.trMonths = {
            oca: 0, şub: 1, sub: 1, mar: 2, nis: 3, may: 4, haz: 5,
            tem: 6, ağu: 7, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11,
        };

        // Series detail HTML fallback selectors (used only if __data.json fails).
        this.selectDetailsTitle = ['#content h1', 'h1'];
        this.selectChapterLinks = ["div.list-episode a", "a[href*='-bolum-oku']", "a[href*='/manga/']"];
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Fall through to the next selector shape on parser-rejected syntax.
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "") : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // ---- CDN / image helpers ---------------------------------------------------

    /** Resolve PUBLIC_CDN_URL from the live homepage HTML once per run. */
    async resolveCdn() {
        if (this._cdnResolved) return this.cdnUrl;
        this._cdnResolved = true;
        try {
            const html = await this.context.httpGet(`https://${this.domain}/`, this);
            const m = html.match(/"PUBLIC_CDN_URL"\s*:\s*"([^"]+)"/);
            if (m && m[1]) this.cdnUrl = m[1];
        } catch {
            // Keep the per-source fallback.
        }
        return this.cdnUrl;
    }

    /** Build an absolute image URL: prefer the CDN, else the site domain. */
    cdnImage(path) {
        if (!path) return "";
        if (/^https?:\/\//i.test(path)) return path;
        const rel = String(path).replace(/^\/+/, "");
        const base = (this.cdnUrl || `https://${this.domain}`).replace(/\/+$/, "");
        return `${base}/${rel}`;
    }

    // ---- SvelteKit __data.json decoding ---------------------------------------

    /**
     * SvelteKit serializes page data as a flat, index-referenced array (devalue).
     * Each node's `data` is `[root, ...pool]`; values are integer indices into the
     * pool, -1 means undefined. Rehydrate into a normal object graph.
     */
    decodeDevalue(flat) {
        const seen = new Map();
        const resolve = (i) => {
            if (i === -1 || i == null) return undefined;
            if (typeof i !== "number") return i;
            if (seen.has(i)) return seen.get(i);
            const v = flat[i];
            if (Array.isArray(v)) {
                const out = [];
                seen.set(i, out);
                for (const e of v) out.push(resolve(e));
                return out;
            }
            if (v && typeof v === "object") {
                const out = {};
                seen.set(i, out);
                for (const k of Object.keys(v)) out[k] = resolve(v[k]);
                return out;
            }
            return v;
        };
        return resolve(0);
    }

    /** Fetch a SvelteKit __data.json and merge every data node into one object. */
    async fetchData(pathname) {
        const base = pathname.replace(/\/+$/, "");
        const url = `https://${this.domain}${base}/__data.json`;
        const raw = await this.context.httpGet(url, this);
        let json;
        try {
            json = JSON.parse(raw);
        } catch {
            return null;
        }
        // A SvelteKit redirect node points at the canonical slug path.
        if (json && json.type === "redirect" && json.location) {
            return this.fetchData(json.location);
        }
        if (!json || !Array.isArray(json.nodes)) return null;
        const merged = {};
        for (const node of json.nodes) {
            if (node && node.type === "data" && Array.isArray(node.data)) {
                const obj = this.decodeDevalue(node.data);
                if (obj && typeof obj === "object") Object.assign(merged, obj);
            }
        }
        return merged;
    }

    // ---- Mapping helpers -------------------------------------------------------

    mangaUrlForSlug(slug) {
        return `/manga/${String(slug).replace(/^\/+/, "")}`;
    }

    parseStatus(status, statusText) {
        // Numeric publicStatus from the API.
        if (status === 1 || status === "1") return MangaState.ONGOING;
        if (status === 2 || status === "2") return MangaState.FINISHED;
        if (status === 3 || status === "3") return MangaState.ABANDONED;
        if (status === 4 || status === "4") return MangaState.PAUSED;
        // Textual fallback (Turkish).
        const v = (statusText || "").toLowerCase();
        if (!v) return undefined;
        if (v.includes("devam ediyor")) return MangaState.ONGOING;
        if (v.includes("tamamland")) return MangaState.FINISHED;
        if (v.includes("birak") || v.includes("bırak")) return MangaState.ABANDONED;
        if (v.includes("ara ver")) return MangaState.PAUSED;
        return undefined;
    }

    parseDate(text) {
        if (!text) return 0;
        // Format like "Oca 5 ,2024" (SimpleDateFormat "MMM d ,yyyy", tr locale).
        const m = String(text).trim().match(/([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{1,2})\s*,?\s*(\d{4})/);
        if (!m) return 0;
        const mon = this.trMonths[m[1].toLowerCase().slice(0, 3)];
        if (mon == null) return 0;
        const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[2])));
        return isNaN(d.getTime()) ? 0 : d.getTime();
    }

    /** Build a Manga stub from a SvelteKit series-card object {slug,name,image,point,...}. */
    cardToManga(card) {
        if (!card || !card.slug) return null;
        const url = this.mangaUrlForSlug(card.slug);
        return new Manga({
            id: url,
            url,
            publicUrl: this.toAbsoluteUrl(url),
            coverUrl: this.cdnImage(card.image),
            title: (card.name || card.title || "").trim(),
            rating: card.point != null ? Math.min(1, Number(card.point) / 10) : 0,
            source: this.source,
            contentRating: this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        });
    }

    // ---- Public API ------------------------------------------------------------

    async getListPage(page, order, filter = {}) {
        await this.resolveCdn();

        const query = (filter && filter.query ? String(filter.query) : "").trim();
        const tags = (filter && filter.tags) || [];

        // Text search via the SvelteKit navbar API (page 1 only — it is not paged).
        if (query) {
            if (page > 1) return [];
            const found = await this.searchByApi(query);
            if (found.length) return found;
            // Fall through to client-side filtering of the homepage lists.
        }

        const data = await this.fetchData("/");
        if (!data) return [];

        let cards = [];
        const popular = data.seriesPopular || {};
        const seen = new Set();
        const collect = (arr) => {
            for (const c of arr || []) {
                if (c && c.slug && !seen.has(c.slug)) { seen.add(c.slug); cards.push(c); }
            }
        };

        if (order === SortOrder.POPULARITY || order === SortOrder.RATING) {
            collect(popular.monthly);
            collect(popular.weekly);
            collect(popular.daily);
        } else if (order === SortOrder.NEWEST) {
            collect(data.newSeries);
            collect(popular.monthly);
        } else if (order === SortOrder.UPDATED) {
            // lastEpisodes.data are series carrying their newest SeriesEpisode entries.
            collect(data.lastEpisodes && data.lastEpisodes.data);
            collect(data.newSeries);
        }
        // Always backfill from every available list so the page is well populated.
        collect(popular.daily);
        collect(popular.weekly);
        collect(popular.monthly);
        collect(data.newSeries);
        collect(data.slider);
        collect(data.lastEpisodes && data.lastEpisodes.data);

        let result = cards.map((c) => this.cardToManga(c)).filter(Boolean);

        // Client-side query filter (degraded search fallback).
        if (query) {
            const q = query.toLowerCase();
            result = result.filter((m) => m.title.toLowerCase().includes(q));
        }
        // Client-side tag filter against slider tags (best-effort; cards lack tags).
        if (tags.length) {
            const wanted = new Set(tags.map((t) => String(t.key || t).toLowerCase()));
            const tagged = cards.filter((c) =>
                Array.isArray(c.tags) && c.tags.some((t) => wanted.has(String(t).toLowerCase()))
            );
            if (tagged.length) result = tagged.map((c) => this.cardToManga(c)).filter(Boolean);
        }

        // Homepage data is not paged; only page 1 has content.
        return page > 1 ? [] : result;
    }

    /** Navbar autocomplete API: returns [{id,name,image,...}]. */
    async searchByApi(query) {
        const url = `https://${this.domain}/api/series/search/navbar?search=${encodeURIComponent(query)}`;
        let raw;
        try {
            raw = await this.context.httpGet(url, this);
        } catch {
            return [];
        }
        const trimmed = (raw || "").trim();
        if (!trimmed || trimmed[0] !== "[") return []; // 404 HTML shell etc.
        let arr;
        try {
            arr = JSON.parse(trimmed);
        } catch {
            return [];
        }
        return arr.map((item) => {
            if (!item) return null;
            const slug = item.slug || item.id;
            if (!slug) return null;
            return this.cardToManga({
                slug,
                name: item.name,
                image: item.image,
                point: item.point,
            });
        }).filter(Boolean);
    }

    async getDetails(manga) {
        await this.resolveCdn();
        const rel = this.toRelativeUrl(manga.url);
        const data = await this.fetchData(rel);
        const series = data && data.series;

        if (series) {
            const slug = series.slug || rel.replace(/^\/manga\//, "");
            const url = this.mangaUrlForSlug(slug);
            const cats = series.resolvedCategories || [];
            const episodes = Array.isArray(series.SeriesEpisode) ? series.SeriesEpisode.slice() : [];
            // SeriesEpisode is newest-first; reverse to oldest-first and number ascending.
            episodes.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

            const chapters = episodes.map((ep, i) => {
                const cUrl = `${url}/${String(ep.slug).replace(/^\/+/, "")}`;
                const num = Number(ep.order);
                const title = ep.name && String(ep.name).trim()
                    ? String(ep.name).trim()
                    : `Bölüm ${ep.order}`;
                return new MangaChapter({
                    id: cUrl,
                    url: cUrl,
                    title,
                    number: isFinite(num) ? num : i + 1,
                    source: this.source,
                });
            }).filter((c) => c.url && String(c.url).includes("-bolum-oku"));

            return new Manga({
                ...manga,
                id: url,
                url,
                publicUrl: this.toAbsoluteUrl(url),
                title: (series.name || manga.title || "").trim(),
                altTitles: [series.nameRomaji, series.nameNative].filter((t) => t && t !== series.name),
                coverUrl: this.cdnImage(series.image) || manga.coverUrl,
                largeCoverUrl: this.cdnImage(series.image) || manga.largeCoverUrl || manga.coverUrl,
                description: series.description || manga.description || "",
                rating: series.point != null ? Math.min(1, Number(series.point) / 10) : (manga.rating || 0),
                tags: cats.map((c) => ({ key: c.slug || c.id, title: c.title || c.name })),
                state: this.parseStatus(series.publicStatus != null ? series.publicStatus : series.status),
                contentRating: this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
                source: this.source,
                chapters,
            });
        }

        // HTML fallback (SSR series page).
        return this.getDetailsFromHtml(manga, rel);
    }

    async getDetailsFromHtml(manga, rel) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(rel), this);
        const doc = this.context.parseHTML(html);
        const content = doc.getElementById("content") || doc;

        const titleEl = this.queryAll(content, this.selectDetailsTitle)[0]
            || this.queryAll(doc, this.selectDetailsTitle)[0];
        const title = titleEl ? titleEl.textContent.trim() : manga.title;

        const links = this.queryAll(doc, this.selectChapterLinks);
        const seen = new Set();
        const raw = [];
        for (const a of links) {
            const href = a.getAttribute("href") || "";
            if (!href.includes("-bolum-oku")) continue;
            const r = this.toRelativeUrl(href).replace(/\/$/, "");
            if (seen.has(r)) continue;
            seen.add(r);
            const numM = r.match(/\/(\d+(?:[.-]\d+)?)-bolum-oku/);
            const num = numM ? Number(numM[1].replace("-", ".")) : null;
            const t = (a.querySelector("h3")?.textContent || a.textContent || "").trim();
            raw.push({ url: r, num, title: t });
        }
        raw.sort((x, y) => (x.num || 0) - (y.num || 0));
        const chapters = raw.map((c, i) => new MangaChapter({
            id: c.url,
            url: c.url,
            title: c.title || `Bölüm ${c.num != null ? c.num : i + 1}`,
            number: c.num != null ? c.num : i + 1,
            source: this.source,
        }));

        const cover = this.imageSrc(content.querySelector("img")) || manga.coverUrl;
        const desc = content.querySelector("div.grid h2 + p")?.textContent?.trim() || manga.description || "";

        return new Manga({
            ...manga,
            title,
            coverUrl: cover,
            largeCoverUrl: cover,
            description: desc,
            contentRating: this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            source: this.source,
            chapters,
        });
    }

    async getPages(chapter) {
        await this.resolveCdn();
        const rel = this.toRelativeUrl(chapter.url);
        const data = await this.fetchData(rel);
        const episode = data && data.episode;

        let images = episode && Array.isArray(episode.images) ? episode.images : null;

        // Fallback: scan the raw episode payload / SSR HTML for image paths.
        if (!images || !images.length) {
            images = await this.getPagesFromRaw(rel);
        }
        if (!images || !images.length) return [];

        return images.map((p, i) => {
            const url = this.cdnImage(p);
            return new MangaPage({
                id: url || String(i),
                url,
                source: this.source,
            });
        }).filter((p) => p.url);
    }

    /** Last-ditch page extraction: pull "/_manga/<id>/<chap>/<n>.<ext>" paths from raw HTML/JSON. */
    async getPagesFromRaw(rel) {
        let raw = "";
        try {
            raw = await this.context.httpGet(`https://${this.domain}${rel.replace(/\/+$/, "")}/__data.json`, this);
        } catch {
            try {
                raw = await this.context.httpGet(this.toAbsoluteUrl(rel), this);
            } catch {
                return [];
            }
        }
        const out = [];
        const seen = new Set();
        const re = /(?:\\?"path\\?"\s*:\s*\\?"|")((?:https?:\/\/[^"\\]+|\/?_manga\/[^"\\]+)\.(?:avif|webp|jpe?g|png))/gi;
        let m;
        while ((m = re.exec(raw)) !== null) {
            const path = m[1];
            if (seen.has(path)) continue;
            seen.add(path);
            out.push(path);
        }
        return out;
    }
}
