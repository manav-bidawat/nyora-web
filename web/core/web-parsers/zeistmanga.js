import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * ZeistManga family parser (Nyora key "zeistmanga", 26 concrete sources).
 *
 * ZeistManga is a Blogger/Blogspot template. The manga list and chapter list
 * are served by the Blogger feed JSON API:
 *   https://<domain>/feeds/posts/default/-/<Label>?alt=json&orderby=published&...
 * Manga details and chapter page images live in normal Blogger post HTML.
 *
 * Everything ZeistManga needs is reachable from fetch + DOMParser:
 *   - list  : Blogger feed JSON (no auth, plain GET)
 *   - details: post HTML (selectors for status/author/tags/synopsis)
 *   - chapters: a second Blogger feed JSON, whose label is discovered from the
 *     details HTML (several template variants: #myUL script, #latest script,
 *     #clwd script, #chapterlist[data-post-title], or `var label_chapter`)
 *   - pages : reader HTML, three strategies (chapterImage = [...] script,
 *     const content = `...` script, or an <img> selector)
 *
 * No AES/protobuf/JS-VM/Cloudflare gaps for this family.
 *
 * Every tunable selector / URL fragment / date string is an instance field so
 * per-source `overrides` can patch it via Object.assign (done by the harness
 * and the Nyora web client after construction).
 */
export class ZeistMangaParser extends BaseParser {
    constructor(context, source, domain, pageSize = 12) {
        super(context, source, domain, pageSize);

        // --- list / search tunables -------------------------------------
        this.maxMangaResults = 20;
        this.mangaCategory = "Series";

        // State label strings used when filtering the list by MangaState.
        this.sateOngoing = "Ongoing";
        this.sateFinished = "Completed";
        this.sateAbandoned = "Cancelled";

        this.datePattern = "yyyy-MM-dd"; // documentary; we parse ISO date below

        // --- details tunables -------------------------------------------
        this.selectTags = "article div.mt-15 a, .info-genre a, dl:contains(Genre) dd a";

        // --- pages tunables ---------------------------------------------
        this.selectPage =
            "div.check-box img, article#reader .separator img, article.container .separator img, #readarea img, #reader img, #readerarea img";

        // Status string buckets (lowercased) -> MangaState.
        this.ongoing = new Set([
            "ongoing", "en curso", "ativo", "lançando", "lancando",
            "مستمر", "devam ediyor", "güncel", "guncel", "en emisión", "en emision",
        ]);
        this.finished = new Set([
            "completed", "completo", "tamamlandı", "tamamlandi", "finalizado", "finalizada",
        ]);
        this.abandoned = new Set([
            "cancelled", "dropped", "dropado", "abandonado", "cancelado", "suspendido",
        ]);
        this.paused = new Set([
            "hiatus",
        ]);
    }

    // queryAll fallback helper (mirrors madara.js). Tries each selector and
    // returns the first non-empty match, tolerating selectors a given DOM
    // implementation rejects.
    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // try the next selector shape
            }
        }
        return [];
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    // Normalise a Blogger thumbnail url up to a larger render (=s###-c -> =w600).
    upgradeThumbnail(url) {
        if (!url) return "";
        return url
            .replace(/\/s.+?-c\//, "/w600/")
            .replace(/=s(?!.*=s).+?-c$/, "=w600")
            .replace(/\/s.+?-c-rw\//, "/w600/")
            .replace(/=s(?!.*=s).+?-c-rw$/, "=w600");
    }

    // Pull the "alternate" link href out of a Blogger feed entry's link array.
    entryHref(entry) {
        const links = Array.isArray(entry.link) ? entry.link : [];
        const alt = links.find((l) => l && l.rel === "alternate") || links[0] || {};
        return alt.href || "";
    }

    // ----------------------------------------------------------------- LIST
    async getListPage(page, order, filter) {
        filter = filter || {};
        const startIndex = this.maxMangaResults * ((page || 1) - 1) + 1;
        const max = this.maxMangaResults + 1;
        let url = `https://${this.domain}/feeds/posts/default/-/`;

        if (filter.query) {
            url += `${encodeURIComponent(this.mangaCategory)}`;
            url += `?alt=json&orderby=published&max-results=${max}&start-index=${startIndex}`;
            url += `&q=label:${encodeURIComponent(this.mangaCategory)}+${encodeURIComponent(filter.query)}`;
        } else {
            const tags = filter.tags ? Array.from(filter.tags) : [];
            const states = filter.states ? Array.from(filter.states) : [];
            if (tags.length && states.length) {
                throw new Error("Filtering by both states and genres is not supported");
            }
            let label;
            if (tags.length) {
                const t = tags[0];
                label = (t && (t.key || t)) || this.mangaCategory;
            } else if (states.length) {
                switch (states[0]) {
                    case MangaState.ONGOING: label = this.sateOngoing; break;
                    case MangaState.FINISHED: label = this.sateFinished; break;
                    case MangaState.ABANDONED: label = this.sateAbandoned; break;
                    default: label = this.mangaCategory; break;
                }
            } else {
                label = this.mangaCategory;
            }
            url += `${encodeURIComponent(label)}`;
            url += `?alt=json&orderby=published&max-results=${max}&start-index=${startIndex}`;
        }

        const text = await this.context.httpGet(url, this);
        let feed;
        try {
            feed = JSON.parse(text).feed;
        } catch {
            return [];
        }
        if (!feed || !Array.isArray(feed.entry)) return [];
        return this.parseMangaList(feed.entry);
    }

    parseMangaList(entries) {
        const out = [];
        for (const entry of entries) {
            const title = entry.title && entry.title.$t ? entry.title.$t : "";
            const href = this.entryHref(entry);
            if (!href) continue;

            let coverUrl = "";
            if (entry.media$thumbnail && entry.media$thumbnail.url) {
                coverUrl = this.upgradeThumbnail(entry.media$thumbnail.url);
            } else if (entry.content && entry.content.$t) {
                try {
                    const cdoc = this.context.parseHTML(entry.content.$t);
                    coverUrl = this.imageSrc(cdoc.querySelector("img"));
                } catch {
                    coverUrl = "";
                }
            }

            const relHref = this.toRelativeUrl(href);
            out.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: href,
                coverUrl: coverUrl || "",
                title,
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return out;
    }

    // -------------------------------------------------------------- DETAILS
    mapState(text) {
        const t = (text || "").trim().toLowerCase();
        if (!t) return undefined;
        if (this.ongoing.has(t)) return MangaState.ONGOING;
        if (this.finished.has(t)) return MangaState.FINISHED;
        if (this.abandoned.has(t)) return MangaState.ABANDONED;
        if (this.paused.has(t)) return MangaState.PAUSED;
        return undefined;
    }

    // Replicates the Kotlin :contains() chain with plain DOM scanning.
    findByLabel(doc, containerSel, labels, valueSel) {
        const containers = this.queryAll(doc, [containerSel]);
        for (const c of containers) {
            const txt = (c.textContent || "").toLowerCase();
            if (labels.some((l) => txt.includes(l.toLowerCase()))) {
                const v = valueSel ? c.querySelector(valueSel) : c;
                if (v) return v;
            }
        }
        return null;
    }

    async getDetails(manga) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(manga.url), this);
        const doc = this.context.parseHTML(html);

        // Status — try the structured-label variants first, then the simple ones.
        let stateEl =
            this.findByLabel(doc, "div.y6x11p", ["Status", "Estado"], ".dt") ||
            this.findByLabel(doc, "ul.infonime li", ["Status", "Estado"], "span") ||
            doc.querySelector("span.status-novel") ||
            doc.querySelector("span[data-status]") ||
            doc.querySelector("[data-status]");
        const state = stateEl ? this.mapState(stateEl.textContent) : undefined;

        // Author
        const authorEl =
            this.findByLabel(doc, "div.y6x11p", ["الكاتب", "Author", "Autor", "Yazar"], ".dt") ||
            this.findByLabel(doc, "dl", ["Author"], "dd") ||
            this.findByLabel(doc, "ul.infonime li", ["Author"], "span");
        const authors = authorEl && authorEl.textContent.trim() ? [authorEl.textContent.trim()] : [];

        // Synopsis
        const descEl =
            doc.getElementById("synopsis") ||
            doc.getElementById("Sinopse") ||
            doc.getElementById("sinopas") ||
            doc.querySelector(".sinopsis") ||
            doc.querySelector(".sinopas");
        const description = descEl ? descEl.textContent.trim() : "";

        // Tags
        const tags = this.queryAll(doc, [this.selectTags]).map((a) => {
            const href = a.getAttribute("href") || "";
            const key = href.split("label/").pop().split("?")[0];
            return { key, title: a.textContent.trim() };
        }).filter((t) => t.key);

        const chapters = await this.loadChapters(manga.url, doc, html);

        return new Manga({
            ...manga,
            authors,
            tags,
            description,
            state,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            chapters,
        });
    }

    // Discover the chapter feed label across template variants, then fetch the
    // chapter feed JSON. Returns chapters oldest-first.
    async loadChapters(mangaUrl, doc, html) {
        let feed = null;

        const myUL = doc.getElementById("myUL");
        const latestScript = doc.querySelector("#latest > script");
        const clwdScript = doc.querySelector("#clwd > script");
        const chapterlist = doc.querySelector("#chapterlist");

        if (myUL) {
            const script = myUL.querySelector("script");
            const src = script ? (script.getAttribute("src") || "") : "";
            if (src) {
                feed = decodeURIComponent(src.split("/-/").pop().split("?")[0]);
            }
        } else if (latestScript) {
            const m = (latestScript.textContent || "").match(/label\s*=\s*'([^']+)'/);
            if (m) feed = m[1];
        } else if (clwdScript) {
            const m = (clwdScript.textContent || "").match(/clwd\.run\('([^']+)'/);
            if (m) feed = m[1];
        } else if (chapterlist) {
            feed = chapterlist.getAttribute("data-post-title") || null;
        } else {
            // script:containsData(var label_chapter)
            const scripts = Array.from(doc.querySelectorAll("script"));
            const labelScript = scripts.find((s) => (s.textContent || "").includes("label_chapter"));
            const data = labelScript ? labelScript.textContent : (html || "");
            const m = data.match(/label_chapter\s*=\s*"([^"]+)"/);
            if (m) feed = m[1];
        }

        if (!feed) return [];

        const url = `https://${this.domain}/feeds/posts/default/-/${feed}?alt=json&orderby=published&max-results=9999`;
        let entries;
        try {
            const json = JSON.parse(await this.context.httpGet(url, this));
            entries = (json.feed && Array.isArray(json.feed.entry)) ? json.feed.entry : [];
        } catch {
            return [];
        }

        // Feed is newest-first; reverse to oldest-first.
        const reversed = entries.slice().reverse();
        const slug = mangaUrl.split("/").filter(Boolean).pop();
        const chapters = [];
        let n = 0;
        for (const entry of reversed) {
            const title = entry.title && entry.title.$t ? entry.title.$t : "";
            const href = this.entryHref(entry);
            if (!href) continue;
            const slugChapter = href.split("/").filter(Boolean).pop();
            if (slug && slug === slugChapter) continue; // skip self-link
            const published = entry.published && entry.published.$t ? entry.published.$t : "";
            const dateText = published.split("T")[0];
            const ts = dateText ? Date.parse(dateText) : 0;
            n += 1;
            const relHref = this.toRelativeUrl(href);
            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title,
                number: n,
                volume: 0,
                branch: null,
                uploadDate: Number.isFinite(ts) ? ts : 0,
                scanlator: null,
                source: this.source,
            }));
        }
        return chapters;
    }

    // ----------------------------------------------------------------- PAGES
    async getPages(chapter) {
        const html = await this.context.httpGet(this.toAbsoluteUrl(chapter.url), this);
        const doc = this.context.parseHTML(html);
        const scripts = Array.from(doc.querySelectorAll("script"));

        // Strategy 1: chapterImage = [ "...", "..." ]
        const chapterImageScript = scripts.find((s) => (s.textContent || "").includes("chapterImage ="));
        if (chapterImageScript) {
            const data = chapterImageScript.textContent;
            const inner = data.substring(data.indexOf("[") + 1, data.indexOf("]"));
            const urls = inner
                .replace(/\s/g, "")
                .replace(/"/g, "")
                .split(",")
                .filter(Boolean);
            const pages = urls.map((url) => new MangaPage({
                id: url,
                url: this.toAbsoluteUrl(url),
                source: this.source,
            })).filter((p) => p.url);
            if (pages.length) return pages;
        }

        // Strategy 2: const content = `...<img src="..."...`;
        const contentScript = scripts.find((s) => (s.textContent || "").includes("const content = "));
        if (contentScript) {
            const data = contentScript.textContent;
            const tickStart = data.indexOf("`");
            const tickEnd = data.indexOf("`;", tickStart + 1);
            if (tickStart >= 0 && tickEnd > tickStart) {
                const block = data.substring(tickStart + 1, tickEnd);
                const pages = block.split('src="').slice(1).map((seg) => {
                    const url = seg.substring(0, seg.indexOf('"'));
                    return new MangaPage({
                        id: url,
                        url: this.toAbsoluteUrl(url),
                        source: this.source,
                    });
                }).filter((p) => p.url);
                if (pages.length) return pages;
            }
        }

        // Strategy 3: plain <img> selector(s).
        const imgs = this.queryAll(doc, [
            this.selectPage,
            "div.check-box img",
            "article#reader .separator img",
            "article.container .separator img",
            "#readarea img",
            "#reader img",
            "#readerarea img",
            "#reader div.separator img",
            ".post-body .separator img",
            ".entry-content img",
            "main .separator img",
            "main[data-chapters-id] img",
        ]);
        const fromDom = imgs.map((img) => {
            const url = this.imageSrc(img);
            return new MangaPage({ id: url, url, source: this.source });
        }).filter((p) => p.url && !p.url.startsWith("data:") && !p.url.startsWith("blob:"));
        if (fromDom.length) return fromDom;

        // Strategy 4 (newer ZeistManga template, e.g. GalaxScans/TyrantScans):
        // the reader markup lives inside a Blogger <main data-chapters-id ...>
        // block that DOM parsers may not expose as live nodes. Fall back to a
        // regex over the served HTML, scoped to the reader <main>/<article> so
        // we do not pick up header/thumbnail/og:image art. These are real
        // <img src="..."> tags in the response, not fabricated.
        return this.extractImagesFromHtml(html);
    }

    extractImagesFromHtml(html) {
        // Prefer the reader container; fall back to the whole document.
        let scope = html;
        const mainStart = html.search(/<main\b[^>]*data-chapters-id/i);
        if (mainStart >= 0) {
            const end = html.indexOf("</main>", mainStart);
            scope = end > mainStart ? html.substring(mainStart, end) : html.substring(mainStart);
        } else {
            const artStart = html.search(/<article\b/i);
            if (artStart >= 0) {
                const end = html.indexOf("</article>", artStart);
                if (end > artStart) scope = html.substring(artStart, end);
            }
        }
        const seen = new Set();
        const pages = [];
        // Pull src/data-src from <img> tags within the scope.
        for (const m of scope.matchAll(/<img\b[^>]*?(?:data-src|src)\s*=\s*["']([^"']+)["']/gi)) {
            let url = m[1];
            if (!url || url.startsWith("data:") || url.startsWith("blob:")) continue;
            // Skip obvious non-page assets (icons, avatars, emoji, og thumbnails).
            if (/(\/icon|avatar|emoji|=s\d{1,3}(-c)?$|\/s\d{1,3}(-c)?\/)/i.test(url)) continue;
            url = this.toAbsoluteUrl(url);
            if (seen.has(url)) continue;
            seen.add(url);
            pages.push(new MangaPage({ id: url, url, source: this.source }));
        }
        return pages;
    }
}
