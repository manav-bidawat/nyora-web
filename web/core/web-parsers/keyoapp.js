import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * KeyoappParser — port of Nyora's KeyoappParser (SinglePageMangaParser) family.
 *
 * Family key "keyoapp", concrete sources:
 *   SCANS4U (4uscans.com), EDSCANLATION (edscanlation.fr), KEWNSCANS (kewnscans.org),
 *   REZOSCANS (rezoscans.com), SURYASCANS (genzupdates.com), NECROSCANS (necroscans.com),
 *   RAISCANS (kenscans.com)
 *
 * Listing is a single non-paginated page at /series (or /latest for UPDATED order).
 * Series cards are `div.grid > div.group` (or `button.group`) with the cover stored as a
 * CSS `background-image:url(...)` on a `.bg-cover` element and the title in an `<h3>` or in
 * the card's `title`/`alt` attribute.
 *
 * Pages: chapter HTML has `#pages > img` elements whose real id is in a `uid` attribute, and
 * a `<script>` defines the CDN base via `realUrl = \`https://<host>/uploads/${uid}\``. The
 * final image URL is `https://<host>/uploads/<uid>`. This is fully reproducible with
 * fetch + DOMParser (no JS VM / no AES decryption required).
 *
 * Honesty note: some sources in this family have since migrated off the classic Keyoapp
 * template (e.g. RAISCANS / kenscans.com -> kencomics.com now serves a React/Radix SPA whose
 * series cards are NOT `div.group` and which exposes no `#chapters`/`#pages` containers). For
 * those, the classic selectors will return empty; see report. The classic-template sources
 * (genzupdates.com, kewnscans.org, etc.) work end-to-end.
 */
export class KeyoappParser extends BaseParser {
    constructor(context, source, domain, pageSize = 100) {
        super(context, source, domain, pageSize);

        // List
        this.listUrl = "series/";           // path used for the "series" / NEWEST listing
        this.latestPath = "latest";          // path segment for UPDATED order
        this.datePattern = "MMM d, yyyy";    // informational; date parsing is hand-rolled below

        // Selectors (instance fields so per-source overrides can patch them)
        this.selectMangaList = "div.grid > div.group";
        this.selectMangaSearch = "#searched_series_page button";
        this.selectTitle = "h3";

        // Details
        this.selectDesc = "div.grid > div.overflow-hidden > p";
        this.selectState = "div[alt=Status]";
        this.selectTag = "div.grid:has(>h1) > div > a";
        this.selectAuthor = "div[alt=Author]";
        // Chapters: anchors inside #chapters that are not flagged "Upcoming".
        this.selectChapter = "#chapters > a";

        // Pages
        this.selectPage = "#pages > img";
        // Extract the CDN host from a script like: realUrl = `https://cdn.meowing.org/uploads/${uid}`
        this.cdnRegex = /realUrl\s*=\s*`[^`]+\/\/([^/`]+)/;
        this.cdnUploadsPath = "/uploads";

        // State word sets (matched lowercased).
        this.ongoing = new Set(["ongoing", "on going"]);
        this.finished = new Set(["completed", "complete", "finished", "end"]);
        this.paused = new Set(["paused", "hiatus", "on hold"]);
        this.upcoming = new Set(["dropped", "upcoming", "coming soon"]);
    }

    queryAll(doc, selectors) {
        for (const selector of selectors.filter(Boolean)) {
            try {
                const elements = Array.from(doc.querySelectorAll(selector));
                if (elements.length) return elements;
            } catch {
                // Some selectors (e.g. :has()) are not supported by every DOM
                // implementation. Fall through to a simpler shape.
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
                // ignore unsupported selectors
            }
        }
        return null;
    }

    // Pull a background-image url(...) out of an element's inline style.
    cssBackgroundUrl(el) {
        if (!el) return "";
        const style = el.getAttribute("style") || "";
        const m = style.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        return m ? m[1].trim() : "";
    }

    coverOf(div) {
        const candidates = [
            "a div.bg-cover",
            "div.bg-cover",
            "a.bg-cover",
            "[style*=background-image]",
        ];
        for (const sel of candidates) {
            let el;
            try { el = div.querySelector(sel); } catch { el = null; }
            const url = this.cssBackgroundUrl(el);
            if (url) return this.toAbsoluteUrl(url);
        }
        return "";
    }

    titleOf(div) {
        const h = this.queryFirst(div, [this.selectTitle, "h3", "h2", "span.text-sm"]);
        const fromHeading = h && h.textContent ? h.textContent.trim() : "";
        if (fromHeading) return fromHeading;
        // Newer markup keeps the human title on the card or its anchor.
        const a = div.querySelector("a");
        const attr = (el) => (el && (el.getAttribute("title") || el.getAttribute("alt")) || "").trim();
        return attr(div) || attr(a) || "";
    }

    parseTags(scope) {
        // From a manga card or details page: links like <a href="?genre=Action">Action</a>.
        const out = [];
        const seen = new Set();
        const anchors = this.queryAll(scope, [
            this.selectTag,
            "div.grid:has(>h1) > div > a",
            "div.gap-1 a",
            "a[href*='genre=']",
            "a[href*='tag=']",
        ]);
        for (const a of anchors) {
            const title = (a.textContent || "").trim();
            if (!title) continue;
            const href = a.getAttribute("href") || "";
            const key = (href.split("=").pop() || title).trim() || title;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ key, title, source: this.source });
        }
        return out;
    }

    contentRating() {
        return this.source && this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE;
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        // Keyoapp listing is a single page. Return nothing past the first page so the
        // caller doesn't keep requesting duplicates.
        if (page && page > 1) return [];

        const segment = order === SortOrder.UPDATED ? this.latestPath : "series";
        const url = `https://${this.domain}/${segment}`;
        const html = await this.context.httpGet(url, this);
        const tag = (filter.tags && filter.tags.length === 1) ? (filter.tags[0].title || filter.tags[0].key || "") : "";
        return this.parseMangaList(html, tag, (filter.query || "").trim());
    }

    parseMangaList(html, tag, query) {
        const doc = this.context.parseHTML(html);
        let elements = this.queryAll(doc, [this.selectMangaSearch, "#searched_series_page button"]);
        if (!elements.length) {
            elements = this.queryAll(doc, [
                this.selectMangaList,
                "div.grid > div.group",
                "div.grid > button.group",
                ".grid .group",
            ]);
        }

        const out = [];
        const seen = new Set();
        for (const div of elements) {
            const a = div.querySelector("a") || (div.tagName === "A" ? div : null);
            const href = a ? a.getAttribute("href") : (div.getAttribute("href") || "");
            if (!href) continue;
            const relHref = this.toRelativeUrl(href);
            if (!/\/series\//.test(relHref) || /\/chapter\//.test(relHref)) continue;
            if (seen.has(relHref)) continue;

            const title = this.titleOf(div);

            // Replicate the Kotlin client-side filtering on the single page.
            if (query && !(title && title.toLowerCase().includes(query.toLowerCase()))) {
                const tagsAttr = (div.getAttribute("tags") || "").toLowerCase();
                if (!tagsAttr.includes(query.toLowerCase())) continue;
            }
            if (tag) {
                const tagsAttr = (div.getAttribute("tags") || "");
                const tagsText = tagsAttr || this.parseTags(div).map((t) => t.title).join(",");
                if (!tagsText.toLowerCase().includes(tag.toLowerCase())) continue;
            }

            seen.add(relHref);
            out.push(new Manga({
                id: relHref,
                url: relHref,
                publicUrl: this.toAbsoluteUrl(relHref),
                coverUrl: this.coverOf(div),
                title,
                tags: this.parseTags(div),
                source: this.source,
                contentRating: this.contentRating(),
            }));
        }
        return out;
    }

    parseState(text) {
        const t = (text || "").trim().toLowerCase();
        if (!t) return undefined;
        if (this.ongoing.has(t)) return MangaState.ONGOING;
        if (this.finished.has(t)) return MangaState.FINISHED;
        if (this.paused.has(t)) return MangaState.PAUSED;
        if (this.upcoming.has(t)) return MangaState.UPCOMING;
        return undefined;
    }

    findState(doc) {
        // Classic markup: <div alt="Status">Ongoing</div>.
        const el = this.queryFirst(doc, [this.selectState, "div[alt=Status]", "div[alt='Status']"]);
        let state = el ? this.parseState(el.textContent) : undefined;
        if (state) return state;
        // Newer markup renders the status as a labelled chip. Scan short chips for a known word.
        for (const chip of this.queryAll(doc, ["[data-status]", "span", "div"])) {
            const dataStatus = chip.getAttribute && chip.getAttribute("data-status");
            state = this.parseState(dataStatus || chip.textContent);
            if (state) return state;
        }
        return undefined;
    }

    chapterTitle(a) {
        const span = this.queryFirst(a, ["span.truncate", "span.text-sm.truncate", "span.text-sm > span", ".chapternum"]);
        const fromSpan = span && span.textContent ? span.textContent.trim() : "";
        if (fromSpan) return fromSpan;
        const attr = (a.getAttribute("title") || a.getAttribute("alt") || "").trim();
        if (attr) return attr;
        return (a.textContent || "").replace(/\s+/g, " ").trim();
    }

    chapterDate(a) {
        // Newer markup: <a ... d="Apr 8, 2026">. Older markup: a trailing date div.
        const attr = (a.getAttribute("d") || "").trim();
        if (attr) return this.parseChapterDate(attr);
        const dateEls = this.queryAll(a, ["div.text-xs.w-fit", "div.text-sm.w-fit", "div.w-fit"]);
        const last = dateEls.length ? dateEls[dateEls.length - 1] : null;
        return this.parseChapterDate(last ? (last.textContent || "").trim() : "");
    }

    isUpcoming(a) {
        // Kotlin excludes chapters whose ".text-sm span" reads "Upcoming".
        const text = (a.textContent || "");
        if (/\bupcoming\b/i.test(text)) {
            // Only treat as upcoming when there is no readable href date/title content.
            const span = a.querySelector(".text-sm span, .text-sm");
            if (span && /upcoming/i.test(span.textContent || "")) return true;
        }
        return false;
    }

    async getDetails(manga) {
        const fullUrl = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const descEl = this.queryFirst(doc, [
            this.selectDesc,
            "div.grid > div.overflow-hidden > p",
            ".overflow-hidden p",
            "div[alt=Description]",
        ]);
        const description = descEl ? (descEl.innerHTML || descEl.textContent || "").trim() : (manga.description || "");

        const title = (doc.querySelector("h1")?.textContent || "").trim() || manga.title;
        const tags = this.parseTags(doc);

        // Classic template uses #chapters > a[href*='/chapter/']. Newer template
        // variants (e.g. kencomics) SSR per-chapter links as /series/<slug>/chapter-N.
        const isChapterHref = (href) => /\/chapter[/\-]/i.test(href) || /\/chapter\//i.test(href);
        let chapterAnchors = this.queryAll(doc, [
            this.selectChapter,
            "#chapters > a",
            "#chapters a[href*='/chapter']",
        ]).filter((a) => {
            const href = a.getAttribute("href") || "";
            return isChapterHref(href) && !this.isUpcoming(a);
        });
        if (!chapterAnchors.length) {
            chapterAnchors = this.queryAll(doc, ["a[href*='/chapter']"]).filter((a) => {
                const href = a.getAttribute("href") || "";
                return isChapterHref(href) && !this.isUpcoming(a);
            });
        }

        // De-dupe (some pages echo the same chapter in multiple containers).
        const seen = new Set();
        const ordered = [];
        for (const a of chapterAnchors) {
            const rel = this.toRelativeUrl(a.getAttribute("href"));
            if (seen.has(rel)) continue;
            seen.add(rel);
            ordered.push(a);
        }

        // Source lists newest first; emit oldest-first with ascending numbers.
        const total = ordered.length;
        const chapters = ordered.map((a, idx) => {
            const rel = this.toRelativeUrl(a.getAttribute("href"));
            const i = total - 1 - idx; // oldest gets index 0
            // Prefer the numeric chapter number embedded in the URL when present.
            const urlNum = (rel.match(/chapter[/\-]([\d.]+)/i) || [])[1];
            return new MangaChapter({
                id: rel,
                url: rel,
                title: this.chapterTitle(a),
                number: urlNum ? parseFloat(urlNum) : (i + 1),
                volume: 0,
                uploadDate: this.chapterDate(a),
                source: this.source,
            });
        }).reverse();

        return new Manga({
            ...manga,
            title,
            description: description || manga.description || "",
            tags: tags.length ? tags : manga.tags,
            state: this.findState(doc) || manga.state,
            contentRating: this.contentRating(),
            chapters,
        });
    }

    getCdnUrl(doc) {
        const scripts = Array.from(doc.querySelectorAll("script"));
        for (const s of scripts) {
            const code = s.textContent || "";
            const m = code.match(this.cdnRegex);
            if (m && m[1]) {
                return `https://${m[1]}${this.cdnUploadsPath}`;
            }
        }
        return null;
    }

    async getPages(chapter) {
        const fullUrl = this.toAbsoluteUrl(chapter.url);
        const html = await this.context.httpGet(fullUrl, this);
        const doc = this.context.parseHTML(html);

        const imgs = this.queryAll(doc, [this.selectPage, "#pages > img", "#pages img"]);
        const cdnUrl = this.getCdnUrl(doc);

        // Preferred path: uid attribute + CDN base from the page script.
        if (cdnUrl) {
            const pages = imgs
                .map((img) => (img.getAttribute("uid") || "").trim())
                .filter(Boolean)
                .map((uid) => {
                    const url = `${cdnUrl}/${uid}`;
                    return new MangaPage({ id: url, url, source: this.source });
                });
            if (pages.length) return pages;
        }

        // Fallback A: #pages imgs that carry a direct src (no CDN script).
        const fromPagesImgs = imgs.map((img) => this.directImageUrl(img)).filter(Boolean);
        if (fromPagesImgs.length) {
            return fromPagesImgs.map((url) => new MangaPage({ id: url, url, source: this.source }));
        }

        // Fallback B: newer template variants (e.g. kencomics) SSR reader images as plain
        // <img> tags pointing at a storage/upload/cdn host, with no #pages container.
        const readerImgs = Array.from(doc.querySelectorAll("img"))
            .map((img) => this.directImageUrl(img))
            .filter((url) => url && /(storage|cdn|uploads?|\/series\/|\/chapter)/i.test(url) && /\.(webp|jpe?g|png|avif)(\?|$)/i.test(url.replace(/.*?url=/i, "")));
        const seen = new Set();
        const pages = [];
        for (const url of readerImgs) {
            if (seen.has(url)) continue;
            seen.add(url);
            pages.push(new MangaPage({ id: url, url, source: this.source }));
        }
        return pages;
    }

    directImageUrl(img) {
        if (!img) return "";
        const raw = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("src") || "";
        if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
        if (/placeholder|favicon|apple-touch|logo|iconify/i.test(raw)) return "";
        return this.toAbsoluteUrl(raw);
    }

    // ----- Date parsing (port of KeyoappParser.parseChapterDate) -----
    parseChapterDate(date) {
        if (!date) return 0;
        const d = date.toLowerCase().trim();
        if (/\bago\b/.test(d)) return this.parseRelativeDate(d);
        if (d.startsWith("today")) {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            return now.getTime();
        }
        // Strip ordinal suffixes like "8th" -> "8" before parsing "Apr 8 2026".
        let cleaned = date;
        if (/\d(st|nd|rd|th)/i.test(date)) {
            cleaned = date.split(" ").map((tok) => /\d\D\D/.test(tok) ? tok.replace(/\D/g, "") : tok).join(" ");
        }
        const ts = Date.parse(cleaned.replace(/,/g, ""));
        return Number.isNaN(ts) ? 0 : ts;
    }

    parseRelativeDate(date) {
        const m = date.match(/(\d+)/);
        const n = m ? parseInt(m[1], 10) : 0;
        if (!n) return 0;
        const now = new Date();
        if (/second/.test(date)) now.setSeconds(now.getSeconds() - n);
        else if (/minute/.test(date)) now.setMinutes(now.getMinutes() - n);
        else if (/hour/.test(date)) now.setHours(now.getHours() - n);
        else if (/day/.test(date)) now.setDate(now.getDate() - n);
        else if (/week/.test(date)) now.setDate(now.getDate() - n * 7);
        else if (/month/.test(date)) now.setMonth(now.getMonth() - n);
        else if (/year/.test(date)) now.setFullYear(now.getFullYear() - n);
        else return 0;
        return now.getTime();
    }
}
