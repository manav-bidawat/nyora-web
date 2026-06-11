import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * FuzzyDoodleParser — port of Nyora's org.koitharu.nyora.parsers.site.fuzzydoodle.FuzzyDoodleParser
 * (PagedMangaParser). Family key "fuzzydoodle".
 *
 * Concrete sources: LELSCANVF (lelscanfr.com), SCYLLACOMICS (scyllacomics.xyz),
 *                   HENTAISLAYER (hentaislayer.net).
 *
 * Tailwind-styled template: a list grid of `div#card-real` entries, a details page
 * with `div#chapters-list > a[href]` chapters and `div#chapter-container img` reader
 * images. No AJAX endpoints, no JSON blobs, no encryption — straight HTML scraping,
 * fully reproducible in a fetch + DOMParser browser context.
 *
 * Every tunable selector / URL fragment / status value is an instance field so a
 * per-source `overrides` object can patch it via Object.assign (see index.js).
 */
export class FuzzyDoodleParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // ---- list / search URL fragments ----
        this.listPath = "/manga";

        // Per-source status query values (LelScanVf / HentaiSlayer override these).
        this.ongoingValue = "ongoing";
        this.finishedValue = "completed";
        this.pausedValue = "haitus";   // (Kotlin spelling preserved on purpose)
        this.abandonedValue = "dropped";

        // Per-source content-type query values.
        this.mangaValue = "manga";
        this.manhwaValue = "manhwa";
        this.manhuaValue = "manhua";
        this.comicsValue = "bande-dessinee";

        // ---- selectors (overridable) ----
        this.selectMangas = "div#card-real";
        this.selectMangaTitle = "h2";

        this.selectAltTitle = "Alternative Titles:";   // label text we scan for
        this.selectState = "a[href*=status] span";
        this.selectAuthorLabels = ["Auteur", "Author", "المؤلف"];
        this.selectDescription = ["p#description", "div:has(> p#description) p", "#description"];
        this.selectTagManga = "a[href*=genre]";

        this.selectChapters = "div#chapters-list > a[href]";
        this.selectChapterName = ["div.gap-2", "#item-title"];
        // The date is the first/grey span of the meta row; views live in a
        // nested <p><span>. Pin to the grey span (and the direct-child span as a
        // fallback) so we never pick up the chapter name or the view count.
        this.selectChapterDate = ["span.text-gray-500", "div.gap-3 > span", "div:has(#item-title) span.mt-1"];

        this.selectPagination = "ul.pagination li[onclick]";

        this.selectPages = ["div#chapter-container img", "img.chapter-image"];

        // ---- status keyword sets (lowercased) ----
        this.ongoing = new Set(["en cours", "ongoing", "مستمر"]);
        this.finished = new Set(["terminé", "dropped", "cancelled", "متوقف", "مكتمل"]);
        this.abandoned = new Set(["canceled", "cancelled", "dropped", "abandonné", "متوقف"]);
        this.paused = new Set(["hiatus", "on hold", "en pause", "en attente"]);
    }

    // ---- helpers (mirrors madara.js conventions) -------------------------

    queryAll(doc, selectors) {
        for (const selector of (selectors || []).filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some overrides (e.g. :has()) aren't supported by every DOM
                // implementation. Fall through to the next known selector.
            }
        }
        return [];
    }

    queryFirst(node, selectors) {
        for (const selector of (selectors || []).filter(Boolean)) {
            try {
                const el = node.querySelector(selector);
                if (el) return el;
            } catch {
                // skip unsupported selector syntax
            }
        }
        return null;
    }

    imageSrc(img) {
        const url = img
            ? (img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "")
            : "";
        if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url || "";
        return this.toAbsoluteUrl(url);
    }

    text(el) {
        return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
    }

    // Some FuzzyDoodle hosts (e.g. lelscanfr.com) do an apex -> www host-level
    // 301. Node/undici's redirect:'follow' is flaky against that particular
    // Cloudflare config and intermittently surfaces the bare 301. To stay
    // deterministic we issue the request, and on any failure retry once against
    // the `www.` (or de-`www.`) variant, pinning `this.domain` to whatever host
    // actually serves 200 so every later request targets the canonical host.
    async httpGetFollow(url) {
        try {
            return await this.context.httpGet(url, this);
        } catch (e) {
            let alt = null;
            try {
                const u = new URL(url);
                if (u.hostname.startsWith("www.")) {
                    u.hostname = u.hostname.slice(4);
                } else {
                    u.hostname = `www.${u.hostname}`;
                }
                alt = u;
            } catch {
                throw e;
            }
            const html = await this.context.httpGet(alt.href, this);
            this.domain = alt.hostname; // pin canonical host for subsequent calls
            return html;
        }
    }

    // ---- list / search ---------------------------------------------------

    buildListUrl(page, filter) {
        const f = filter || {};
        let url = `https://${this.domain}${this.listPath}?page=${page}`;

        // Content type (single value; first tag-as-type if provided).
        url += "&type=";

        // Query (title search).
        if (f.query) url += `&title=${encodeURIComponent(f.query)}`;

        // State -> status value.
        url += "&status=";
        const states = f.states || [];
        const state = Array.isArray(states) ? states[0] : states;
        if (state) {
            let sv = "";
            switch (state) {
                case MangaState.ONGOING: sv = this.ongoingValue; break;
                case MangaState.FINISHED: sv = this.finishedValue; break;
                case MangaState.PAUSED: sv = this.pausedValue; break;
                case MangaState.ABANDONED: sv = this.abandonedValue; break;
            }
            url += sv;
        }

        // Tags -> repeated genre[] params (key already URL-safe in practice).
        const tags = f.tags || [];
        for (const t of tags) {
            const key = (t && (t.key !== undefined ? t.key : t)) || "";
            url += `&${encodeURIComponent("genre[]")}=${key}`;
        }
        return url;
    }

    async getListPage(page, order, filter) {
        // Kotlin's PagedMangaParser is 1-based and the smoke harness calls
        // getListPage(1, ...); pass the page through unchanged.
        const url = this.buildListUrl(page, filter);
        const html = await this.httpGetFollow(url);
        return this.parseMangaList(this.context.parseHTML(html));
    }

    parseMangaList(doc) {
        const cards = this.queryAll(doc, [this.selectMangas, "div#card-real", "div[id=card-real]"]);
        const list = [];
        for (const div of cards) {
            const a = div.querySelector("a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            const img = div.querySelector("img");
            const titleEl = this.queryFirst(div, [this.selectMangaTitle, "h2", "h3"]);
            list.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(href),
                coverUrl: this.imageSrc(img),
                title: this.text(titleEl) || (img && img.getAttribute("alt") || "").trim(),
                source: this.source,
                contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            }));
        }
        return list;
    }

    // ---- details ---------------------------------------------------------

    // Finds the value <span> next to a label <span> whose text matches one of
    // `labels`. Replaces Kotlin's `p:contains(Auteur) span` (no :contains in DOM).
    findLabeledValue(doc, labels) {
        const wanted = labels.map((l) => l.toLowerCase());
        for (const p of Array.from(doc.querySelectorAll("p, div.flex, div"))) {
            const spans = Array.from(p.querySelectorAll(":scope > span, :scope > a > span, span"));
            if (spans.length < 2) continue;
            const labelTxt = this.text(spans[0]).toLowerCase();
            if (wanted.some((w) => labelTxt.includes(w))) {
                // Last span is the value (e.g. "Auteur" -> "Kazuki").
                const val = this.text(spans[spans.length - 1]);
                if (val && val.toLowerCase() !== labelTxt) return val;
            }
        }
        return "";
    }

    parseState(doc) {
        const stateEl = this.queryFirst(doc, [this.selectState, "a[href*=status] span", "a[href*='status'] span"]);
        const s = this.text(stateEl).toLowerCase();
        if (!s) return undefined;
        if (this.ongoing.has(s)) return MangaState.ONGOING;
        if (this.finished.has(s)) return MangaState.FINISHED;
        if (this.abandoned.has(s)) return MangaState.ABANDONED;
        if (this.paused.has(s)) return MangaState.PAUSED;
        // loose contains-match as a fallback for decorated values
        const has = (set) => Array.from(set).some((k) => s.includes(k));
        if (has(this.ongoing)) return MangaState.ONGOING;
        if (has(this.finished)) return MangaState.FINISHED;
        if (has(this.abandoned)) return MangaState.ABANDONED;
        if (has(this.paused)) return MangaState.PAUSED;
        return undefined;
    }

    parseAltTitle(doc) {
        const label = (this.selectAltTitle || "").toLowerCase();
        for (const block of Array.from(doc.querySelectorAll("div.flex, div"))) {
            const spans = Array.from(block.querySelectorAll(":scope > span"));
            if (spans.length < 2) continue;
            if (this.text(spans[0]).toLowerCase().includes(label)) {
                return this.text(spans[spans.length - 1]);
            }
        }
        return "";
    }

    parseTitle(doc) {
        const h = doc.querySelector("h2.text-2xl, h2.font-bold, h1");
        if (!h) return "";
        // The series-type badge (e.g. " [Manga] ") sits in a child <span>; the
        // bare title is the element's own direct text nodes.
        let t = "";
        for (const node of Array.from(h.childNodes)) {
            if (node.nodeType === 3 /* TEXT_NODE */) t += node.textContent;
        }
        t = t.replace(/\s+/g, " ").trim();
        if (t) return t;
        // No direct text node (whole title was wrapped) -> strip trailing [..].
        return this.text(h).replace(/\s*\[[^\]]*\]\s*$/, "").trim();
    }

    // Reads the synopsis. The site emits <p id="description"><p>...</p></p>,
    // which the HTML5 parser flattens (a <p> can't nest a <p>), leaving
    // #description empty and the real text in following-sibling <p> nodes.
    parseDescription(doc) {
        const el = this.queryFirst(doc, this.selectDescription);
        if (!el) return "";
        if (el.innerHTML && el.innerHTML.trim()) return el.innerHTML;
        // Gather the hoisted sibling <p> content that belongs to the synopsis.
        const parts = [];
        let sib = el.nextElementSibling;
        while (sib && sib.tagName === "P") {
            if (sib.id && sib.id !== el.id) break;
            parts.push(sib.innerHTML);
            sib = sib.nextElementSibling;
        }
        if (parts.length) return parts.join("");
        // Last resort: the parent container's text (minus the empty marker).
        return el.parentElement ? el.parentElement.innerHTML : "";
    }

    parseTags(doc) {
        const els = this.queryAll(doc, [this.selectTagManga, "a[href*=genre]", "div.flex > a.inline-block"]);
        const seen = new Set();
        const tags = [];
        for (const a of els) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/genre(?:\[\])?=([^&]+)/);
            const key = m ? decodeURIComponent(m[1]) : href.split("=").pop();
            const title = this.text(a) || key;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            tags.push({ key, title, source: this.source });
        }
        return tags;
    }

    maxChapterPage(doc) {
        const els = this.queryAll(doc, [this.selectPagination, "ul.pagination li[onclick]"]);
        let max = 1;
        for (const li of els) {
            const onclick = li.getAttribute("onclick") || "";
            // onclick="...=N'..."  -> grab digits after the last '='
            const m = onclick.substring(onclick.lastIndexOf("=") + 1).match(/\d+/);
            const n = m ? parseInt(m[0], 10) : NaN;
            if (Number.isFinite(n) && n > max) max = n;
        }
        return max;
    }

    parseChapters(doc, indexOffset = 0) {
        const els = this.queryAll(doc, [this.selectChapters, "div#chapters-list > a[href]", "div#chapters-list a[href]"]);
        const chapters = [];
        els.forEach((a, i) => {
            const href = a.getAttribute("href");
            if (!href) return;
            const relHref = this.toRelativeUrl(href);
            const nameEl = this.queryFirst(a, this.selectChapterName);
            const name = this.text(nameEl) || this.text(a);
            const dateEl = this.queryFirst(a, this.selectChapterDate);
            const dateText = this.text(dateEl);

            // Chapter number from trailing path segment: "/maria-no-danzai/32" -> 32
            const last = relHref.replace(/\/+$/, "").split("/").pop() || "";
            const numStr = last.replace(/-/g, ".").replace(/[^0-9.]/g, "");
            const number = parseFloat(numStr);

            chapters.push(new MangaChapter({
                id: relHref,
                url: relHref,
                title: name,
                number: Number.isFinite(number) ? number : (indexOffset + i + 1),
                volume: 0,
                branch: null,
                scanlator: null,
                uploadDate: this.parseChapterDate(dateText),
                source: this.source,
            }));
        });
        return chapters;
    }

    async getDetails(manga) {
        const mangaUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.httpGetFollow(mangaUrl);
        const doc = this.context.parseHTML(html);

        const maxPage = this.maxChapterPage(doc);
        let chapters = this.parseChapters(doc);

        // Additional chapter pages (rare) are appended, then reversed -> oldest first.
        if (maxPage > 1) {
            const base = mangaUrl.replace(/\?.*$/, "");
            for (let p = 2; p <= maxPage; p++) {
                try {
                    const sep = base.includes("?") ? "&" : "?";
                    const more = await this.httpGetFollow(`${base}${sep}page=${p}`);
                    chapters = chapters.concat(this.parseChapters(this.context.parseHTML(more), chapters.length));
                } catch {
                    // Stop paginating on the first failed page; keep what we have.
                    break;
                }
            }
        }
        chapters.reverse(); // oldest first

        const author = this.findLabeledValue(doc, this.selectAuthorLabels);
        const description = this.parseDescription(doc) || (manga.description || "");
        const altTitle = this.parseAltTitle(doc);
        const title = this.parseTitle(doc) || manga.title;

        return new Manga({
            ...manga,
            title: title || manga.title,
            altTitles: altTitle ? [altTitle] : (manga.altTitles || []),
            authors: author ? [author] : (manga.authors || []),
            description,
            state: this.parseState(doc),
            tags: this.parseTags(doc),
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
            chapters,
        });
    }

    // ---- pages -----------------------------------------------------------

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.httpGetFollow(fullUrl);
        const doc = this.context.parseHTML(html);
        const imgs = this.queryAll(doc, this.selectPages);
        const pages = [];
        for (const img of imgs) {
            const url = this.imageSrc(img);
            if (!url || url.startsWith("data:")) continue;
            pages.push(new MangaPage({
                id: url,
                url,
                preview: null,
                source: this.source,
            }));
        }
        return pages;
    }

    // ---- date parsing (mirrors Kotlin parseChapterDate/parseRelativeDate) -

    parseChapterDate(dateText) {
        if (!dateText) return 0;
        const d = dateText.toLowerCase().trim();
        if (!d) return 0;
        // Relative dates: "il y a 10 mois", "10 months ago", "منذ ...", "... مضت"
        if (/(ago|مضت)$/.test(d) || /^(il y a|منذ)/.test(d)) {
            return this.parseRelativeDate(d);
        }
        // Absolute date like "January 5, 2024" — best-effort via Date.parse.
        const t = Date.parse(dateText);
        return Number.isFinite(t) ? t : 0;
    }

    parseRelativeDate(date) {
        const m = date.match(/(\d+)/);
        const n = m ? parseInt(m[1], 10) : 0;
        if (!n) return 0;
        const now = Date.now();
        const any = (words) => words.some((w) => date.includes(w));
        const MIN = 60000, HOUR = 3600000, DAY = 86400000;
        if (any(["detik", "segundo", "second", "ثوان"])) return now - n * 1000;
        if (any(["menit", "dakika", "min", "minute", "minutes", "minuto", "mins", "phút", "минут", "دقيقة"])) return now - n * MIN;
        if (any(["jam", "saat", "heure", "hora", "horas", "hour", "hours", "ساعات", "ساعة"])) return now - n * HOUR;
        if (any(["jour", "día", "dia", "day", "days", "hari", "gün", "день"])) return now - n * DAY;
        if (any(["semaine", "week", "weeks", "semana", "semanas"])) return now - n * 7 * DAY;
        if (any(["mois", "month", "months", "أشهر"])) return now - n * 30 * DAY;
        if (any(["année", "an", "ans", "year", "years"])) return now - n * 365 * DAY;
        return 0;
    }
}
