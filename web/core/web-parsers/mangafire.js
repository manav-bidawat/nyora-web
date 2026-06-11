import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangaFire (mangafire.to). Its AJAX endpoints require a per-request `vrf`
 * verification token (RC4 + byte-transform pipeline with hardcoded keys) — ported
 * from the Nyora parser. Chapter list and page images come from /ajax/read.
 *
 * Page images carry an `offset`: 0 = plain URL, >=1 = column-scrambled (the image
 * loader must un-shuffle via `#scrambled_<offset>`). Currently the site serves
 * offset 0 (no scramble); the fragment is emitted for forward-compatibility.
 */

// ---- VRF token (ported 1:1 from Nyora's VrfGenerator) -------------------
const VRF = (() => {
    const dec = (b64) => {
        const bin = atob(b64);
        const a = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
    };
    const rc4 = (key, input) => {
        const s = new Uint8Array(256);
        for (let i = 0; i < 256; i++) s[i] = i;
        let j = 0;
        for (let i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 0xFF; const t = s[i]; s[i] = s[j]; s[j] = t; }
        const out = new Uint8Array(input.length);
        let i = 0; j = 0;
        for (let y = 0; y < input.length; y++) {
            i = (i + 1) & 0xFF; j = (j + s[i]) & 0xFF;
            const t = s[i]; s[i] = s[j]; s[j] = t;
            out[y] = input[y] ^ s[(s[i] + s[j]) & 0xFF];
        }
        return out;
    };
    const add8 = (n) => (c) => (c + n) & 0xFF;
    const sub8 = (n) => (c) => (c - n + 256) & 0xFF;
    const rotl8 = (n) => (c) => ((c << n) | (c >>> (8 - n))) & 0xFF;
    const rotr8 = (n) => (c) => ((c >>> n) | (c << (8 - n))) & 0xFF;
    const sC = [sub8(223), rotr8(4), rotr8(4), add8(234), rotr8(7), rotr8(2), rotr8(7), sub8(223), rotr8(7), rotr8(6)];
    const sY = [add8(19), rotr8(7), add8(19), rotr8(6), add8(19), rotr8(1), add8(19), rotr8(6), rotr8(7), rotr8(4)];
    const sB = [sub8(223), rotr8(1), add8(19), sub8(223), rotl8(2), sub8(223), add8(19), rotl8(1), rotl8(2), rotl8(1)];
    const sJ = [add8(19), rotl8(1), rotl8(1), rotr8(1), add8(234), rotl8(1), sub8(223), rotl8(6), rotl8(4), rotl8(1)];
    const sE = [rotr8(1), rotl8(1), rotl8(6), rotr8(1), rotl8(2), rotr8(4), rotl8(1), rotl8(1), sub8(223), rotl8(2)];
    const transform = (input, seed, prefix, sch) => {
        const out = [];
        for (let i = 0; i < input.length; i++) {
            if (i < prefix.length) out.push(prefix[i]);
            out.push(sch[i % 10]((input[i] ^ seed[i % 32]) & 0xFF) & 0xFF);
        }
        return new Uint8Array(out);
    };
    const K = { l: "FgxyJUQDPUGSzwbAq/ToWn4/e8jYzvabE+dLMb1XU1o=", g: "CQx3CLwswJAnM1VxOqX+y+f3eUns03ulxv8Z+0gUyik=", B: "fAS+otFLkKsKAJzu3yU+rGOlbbFVq+u+LaS6+s1eCJs=", m: "Oy45fQVK9kq9019+VysXVlz1F9S1YwYKgXyzGlZrijo=", F: "aoDIdXezm2l3HrcnQdkPJTDT8+W6mcl2/02ewBHfPzg=" };
    const SD = { A: "yH6MXnMEcDVWO/9a6P9W92BAh1eRLVFxFlWTHUqQ474=", V: "RK7y4dZ0azs9Uqz+bbFB46Bx2K9EHg74ndxknY9uknA=", N: "rqr9HeTQOg8TlFiIGZpJaxcvAaKHwMwrkqojJCpcvoc=", P: "/4GPpmZXYpn5RpkP7FC/dt8SXz7W30nUZTe8wb+3xmU=", k: "wsSGSBXKWA9q1oDJpjtJddVxH+evCfL5SO9HZnUDFU8=" };
    const PK = { O: "l9PavRg=", v: "Ml2v7ag1Jg==", L: "i/Va0UxrbMo=", p: "WFjKAHGEkQM=", W: "5Rr27rWd" };
    const b64url = (b) => {
        let s = "";
        for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    };
    return {
        generate(input) {
            let b = new TextEncoder().encode(encodeURIComponent(String(input)));
            b = rc4(dec(K.l), b); b = transform(b, dec(SD.A), dec(PK.O), sC);
            b = rc4(dec(K.g), b); b = transform(b, dec(SD.V), dec(PK.v), sY);
            b = rc4(dec(K.B), b); b = transform(b, dec(SD.N), dec(PK.L), sB);
            b = rc4(dec(K.m), b); b = transform(b, dec(SD.P), dec(PK.p), sJ);
            b = rc4(dec(K.F), b); b = transform(b, dec(SD.k), dec(PK.W), sE);
            return b64url(b);
        },
    };
})();

export class MangaFireParser extends BaseParser {
    constructor(context, source, domain, pageSize = 30) {
        super(context, source, domain, pageSize);
    }

    get lang() {
        return (this.source && (this.source.locale || this.source.lang)) || "en";
    }

    sortValue(order) {
        switch (order) {
            case SortOrder.UPDATED: return "recently_updated";
            case SortOrder.POPULARITY: return "most_viewed";
            case SortOrder.RATING: return "scores";
            case SortOrder.NEWEST: return "release_date";
            case SortOrder.ALPHABETICAL: return "title_az";
            case SortOrder.RELEVANCE: return "most_relevance";
            default: return "most_viewed";
        }
    }

    async getJson(url) {
        return JSON.parse(await this.context.httpGet(url, this));
    }

    async getListPage(page, order, filter) {
        filter = filter || {};
        const lang = this.lang;
        let url = `https://${this.domain}/filter?page=${page}&language[]=${encodeURIComponent(lang)}`;
        if (filter.query) {
            const q = filter.query.trim();
            const kw = q.replace(/\s+/g, "+");
            url += `&keyword=${encodeURIComponent(kw).replace(/%2B/g, "+")}`;
            url += `&vrf=${encodeURIComponent(VRF.generate(q))}`;
            url += `&sort=most_relevance`;
        } else {
            url += `&sort=${this.sortValue(order)}`;
        }
        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);
        const items = doc.querySelectorAll(".original.card-lg .unit .inner, .original .unit .inner, .unit .inner");
        const out = [];
        for (const el of Array.from(items)) {
            const a = el.querySelector(".info > a, .info a");
            if (!a) continue;
            const href = a.getAttribute("href");
            if (!href || !href.includes("/manga/")) continue;
            const img = el.querySelector("img");
            const cover = img ? (img.getAttribute("src") || img.getAttribute("data-src") || "") : "";
            const rel = this.toRelativeUrl(href);
            out.push(new Manga({
                id: rel,
                url: rel,
                publicUrl: this.toAbsoluteUrl(rel),
                title: (a.textContent || "").trim(),
                coverUrl: cover ? this.toAbsoluteUrl(cover) : "",
                source: this.source,
                contentRating: ContentRating.SAFE,
            }));
        }
        return out;
    }

    async getDetails(manga) {
        const url = this.toAbsoluteUrl(manga.url);
        const html = await this.context.httpGet(url, this);
        const doc = this.context.parseHTML(html);

        const title = doc.querySelector(".info > h1, .info h1, h1[itemprop='name']")?.textContent?.trim() || manga.title;
        const coverRaw = doc.querySelector("div.manga-detail div.poster img, .poster img")?.getAttribute("src") || "";
        const descEl = doc.querySelector("#synopsis div.modal-content, #synopsis .modal-content, #synopsis, .description");
        const description = descEl ? (descEl.textContent || "").trim() : "";
        const genreEls = doc.querySelectorAll("div.meta a[href*='/genre/'], .meta a[href*='/genre/']");
        const tags = Array.from(genreEls).map((a) => {
            const t = (a.textContent || "").trim();
            const key = ((a.getAttribute("href") || "").match(/\/genre\/([^/?#]+)/) || [])[1] || t.toLowerCase();
            return { title: t, key };
        }).filter((g) => g.title);

        let chapters = [];
        try { chapters = await this.getChapters(manga.url, doc); } catch { chapters = []; }

        return new Manga({
            ...manga,
            title,
            coverUrl: coverRaw ? this.toAbsoluteUrl(coverRaw) : manga.coverUrl,
            description,
            tags,
            chapters,
        });
    }

    async getChapters(mangaUrl, doc) {
        const lang = this.lang;
        const mangaId = String(mangaUrl).substring(String(mangaUrl).lastIndexOf(".") + 1);

        const availableTypes = Array.from(doc.querySelectorAll(".chapvol-tab > a")).map((a) => a.getAttribute("data-name")).filter(Boolean);
        const branches = [];
        for (const tc of Array.from(doc.querySelectorAll(".m-list div.tab-content"))) {
            const type = tc.getAttribute("data-name");
            for (const item of Array.from(tc.querySelectorAll(".list-menu .dropdown-item"))) {
                branches.push({ type, langCode: (item.getAttribute("data-code") || "").toLowerCase(), langTitle: item.getAttribute("data-title") || "" });
            }
        }
        let wanted = branches.filter((b) => b.langCode === lang && (availableTypes.length === 0 || availableTypes.includes(b.type)));
        // Fallback: site markup not present (or AJAX-only) — assume chapter/lang.
        if (!wanted.length) wanted = [{ type: "chapter", langCode: lang, langTitle: lang.toUpperCase() }];
        // Prefer "chapter" branches over "volume".
        const chapterBranches = wanted.filter((b) => b.type === "chapter");
        const useBranches = chapterBranches.length ? chapterBranches : wanted;

        let all = [];
        for (const b of useBranches) {
            const br = await this.getChaptersBranch(mangaId, b);
            all = all.concat(br);
        }
        return all;
    }

    async getChaptersBranch(mangaId, branch) {
        const readVrf = VRF.generate(`${mangaId}@${branch.type}@${branch.langCode}`);
        const j = await this.getJson(`https://${this.domain}/ajax/read/${mangaId}/${branch.type}/${branch.langCode}?vrf=${encodeURIComponent(readVrf)}`);
        const listHtml = (j && j.result && j.result.html) || "";
        const listDoc = this.context.parseHTML(listHtml);
        const aEls = Array.from(listDoc.querySelectorAll("ul li a"));

        // Upload dates / titles come from a separate (unsigned) endpoint.
        let dateAs = [];
        if (branch.type === "chapter") {
            try {
                const jm = await this.getJson(`https://${this.domain}/ajax/manga/${mangaId}/${branch.type}/${branch.langCode}`);
                const mhtml = (jm && jm.result) || "";
                if (typeof mhtml === "string") dateAs = Array.from(this.context.parseHTML(mhtml).querySelectorAll("ul li a"));
            } catch { /* ignore */ }
        }

        const chapters = aEls.map((a, i) => {
            const chapterId = a.getAttribute("data-id");
            if (!chapterId) return null;
            const number = parseFloat(a.getAttribute("data-number"));
            const titleAttr = (a.getAttribute("title") || "").trim();
            const chUrl = `${mangaId}/${branch.type}/${branch.langCode}/${chapterId}`;
            return new MangaChapter({
                id: chUrl,
                url: chUrl,
                title: titleAttr || `${branch.type === "volume" ? "Volume" : "Chapter"} ${a.getAttribute("data-number") || (i + 1)}`,
                number: Number.isFinite(number) ? number : (i + 1),
                source: this.source,
            });
        }).filter(Boolean);
        // Site lists newest-first; UI convention is oldest-first.
        chapters.reverse();
        return chapters;
    }

    async getPages(chapter) {
        const parts = String(chapter.url).split("/");
        const type = parts[1] || "chapter";
        const chapterId = parts[3] || parts[parts.length - 1];
        const vrf = VRF.generate(`${type}@${chapterId}`);
        const j = await this.getJson(`https://${this.domain}/ajax/read/${type}/${chapterId}?vrf=${encodeURIComponent(vrf)}`);
        const images = (j && j.result && j.result.images) || [];
        return images.map((img) => {
            const u = Array.isArray(img) ? img[0] : (img && img.url);
            const offset = Array.isArray(img) ? img[2] : (img && img.offset);
            const full = (offset && offset >= 1) ? `${u}#scrambled_${offset}` : u;
            return new MangaPage({
                id: u,
                url: full,
                source: this.source,
                headers: { "Referer": `https://${this.domain}/` },
            });
        }).filter((p) => p.url);
    }
}
