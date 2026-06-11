import { BaseParser, Manga, MangaChapter, MangaPage, MangaState, SortOrder, ContentRating } from './base.js';

/**
 * MangoThemeParser — port of Nyora's MangoThemeParser (key "mangotheme").
 *
 * This is a JSON-API family (a custom "MangoToons" backend), NOT an HTML-scraping
 * family. Every screen is backed by a REST endpoint under `${apiBaseUrl}` that
 * returns either plaintext JSON, or an AES-CBC-encrypted hex payload of the form
 * `<ivHex>:<cipherHex>`. We decrypt those in-browser with the Web Crypto API
 * (SubtleCrypto), exactly mirroring MangoThemeDecrypt.kt:
 *   key  = SHA-256( encryptionKey + "salt" )         (32 bytes => AES-256)
 *   algo = AES/CBC/PKCS5Padding, IV = hex part before ':'
 * A body already starting with '{' or '[' is treated as plaintext (no decrypt).
 *
 * HONEST GAP (read STEP-4 caveat in the report):
 *   Most endpoints (latest list, search, obra details, chapter pages) require the
 *   request header `X-API-Token: <token>` on a GET request. The Nyora web context
 *   only exposes `httpGet(url, parser)` (no per-request headers) and routes through
 *   a CORS proxy that strips arbitrary request headers; `httpPost` carries headers
 *   but the API rejects the POST method ("Rota não encontrada"). So in the current
 *   runtime the token cannot reach the origin on a GET, and those endpoints answer
 *   with an (encrypted) 401 "Token da API não fornecido".
 *   The ONE endpoint that works token-free is the popularity list
 *   (`obras/top10/views`), which is why POPULARITY browsing succeeds end-to-end.
 *   To stay forward-compatible, every token-gated request is still issued with the
 *   token threaded as a 3rd argument to httpGet (`httpGet(url, this, headers)`);
 *   a header-aware context/proxy would immediately light up details + pages with
 *   zero further changes. We never fabricate data: if a body decrypts to an error
 *   JSON, the corresponding list/detail simply comes back empty.
 */
export class MangoThemeParser extends BaseParser {
    constructor(context, source, domain, pageSize = 24) {
        super(context, source, domain, pageSize);

        // --- Per-source tunables (patched via `overrides` / Object.assign) ----
        this.cdnUrl = `https://cdn.${domain}`;
        this.apiBaseUrl = `https://api.${domain}/api`;
        this.encryptionKey = "mangotoons_encryption_key_2025";
        this.apiToken = "bunker_api_token_secreto_2025";
        this.webMangaPathSegment = "manga";
        this.latestPageSize = 24;
        this.searchPageSize = 20;
        this.decryptSalt = "salt";

        // status_id -> MangaState. Defaults follow ImperiodaBritannia.kt.
        this.statusIdsByState = {
            ONGOING: ["1", "6"],
            FINISHED: ["3"],
            PAUSED: ["2", "5"],
            ABANDONED: ["4"],
        };
        // formato_id values that mark a title as adult.
        this.adultFormatIds = ["23"];
    }

    // ---- low-level JSON / crypto helpers ---------------------------------

    apiUrl(path) {
        const base = (this.apiBaseUrl || `https://${this.domain}/api`).replace(/\/+$/, "");
        return `${base}/${String(path).replace(/^\/+/, "")}`;
    }

    apiHeaders() {
        // Threaded to httpGet's 3rd arg; harmless if the context ignores it.
        const headers = {
            "Referer": `https://${this.domain}/`,
            "Accept-Language": "pt-BR, pt;q=0.9, en-US;q=0.8, en;q=0.7",
            // Ask the backend to skip encryption when it honours this header;
            // we can still decrypt if it does not.
            "X-Noencryptionbritta": "1",
        };
        if (this.apiToken) {
            headers["X-API-Token"] = this.apiToken;
            headers["Authorization"] = `Bearer ${this.apiToken}`;
        }
        return headers;
    }

    hexToBytes(hex) {
        const clean = String(hex).trim();
        const out = new Uint8Array(clean.length >> 1);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return out;
    }

    async decryptPayload(payload) {
        const trimmed = String(payload || "").trim();
        if (!trimmed) return "";
        // Plaintext JSON passes straight through (matches MangoThemeDecrypt.kt).
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
        const sep = trimmed.indexOf(":");
        if (sep <= 0) return trimmed; // not an encrypted payload we recognise
        const ivHex = trimmed.slice(0, sep);
        const cipherHex = trimmed.slice(sep + 1);
        if (!/^[0-9a-fA-F]+$/.test(ivHex) || !/^[0-9a-fA-F]+$/.test(cipherHex)) {
            return trimmed;
        }
        const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
        if (!subtle) throw new Error("Web Crypto (crypto.subtle) unavailable for MangoTheme decrypt");
        const keyMaterial = await subtle.digest(
            "SHA-256",
            new TextEncoder().encode(this.encryptionKey + this.decryptSalt),
        );
        const key = await subtle.importKey("raw", keyMaterial, { name: "AES-CBC" }, false, ["decrypt"]);
        const plain = await subtle.decrypt(
            { name: "AES-CBC", iv: this.hexToBytes(ivHex) },
            key,
            this.hexToBytes(cipherHex),
        );
        return new TextDecoder().decode(plain);
    }

    async requestJson(url) {
        // Forward the API headers as a 3rd arg (forward-compatible: ignored by the
        // current context, honoured by a header-aware runtime).
        const raw = await this.context.httpGet(url, this, this.apiHeaders());
        const text = await this.decryptPayload(raw);
        try {
            return JSON.parse(text);
        } catch {
            return {};
        }
    }

    // ---- url helpers (mirror the Kotlin internal-url scheme) -------------

    toAbsoluteCdnUrl(value) {
        const v = String(value || "");
        if (!v) return "";
        if (v.startsWith("http://") || v.startsWith("https://")) return v;
        return `${(this.cdnUrl || "").replace(/\/+$/, "")}/${v.replace(/^\/+/, "")}`;
    }

    buildInternalMangaUrl(mangaId, slug) {
        let url = `/obra/${mangaId}`;
        if (slug) url += `?slug=${slug}`;
        return url;
    }

    buildInternalChapterUrl(mangaId, chapterNumber, slug) {
        let url = `/obra/${mangaId}/capitulo/${chapterNumber}`;
        if (slug) url += `?slug=${slug}`;
        return url;
    }

    extractMangaId(url) {
        const after = String(url || "").split("/obra/")[1] || "";
        return after.split("/")[0].split("?")[0];
    }

    extractChapterNumber(url) {
        const last = String(url || "").split("/").pop() || "";
        return last.split("?")[0];
    }

    formatChapterNumber(numberRaw) {
        const f = parseFloat(numberRaw);
        if (Number.isNaN(f)) return String(numberRaw);
        // Drop a trailing ".0" so "1.00" -> "1", "19.50" -> "19.5".
        let s = String(f);
        return s;
    }

    // ---- parsing -----------------------------------------------------------

    getString(obj, ...keys) {
        for (const k of keys) {
            const v = obj ? obj[k] : undefined;
            if (v !== undefined && v !== null && String(v).length) return String(v);
        }
        return null;
    }

    parseTags(arr) {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const tag of arr) {
            const id = parseInt(tag && tag.id, 10);
            if (!(id > 0)) continue;
            const title = this.getString(tag, "nome", "name");
            if (!title) continue;
            out.push({ key: String(id), title });
        }
        return out;
    }

    parseState(json) {
        const statusId = json && json.status_id != null ? String(json.status_id) : null;
        if (statusId != null) {
            for (const [state, ids] of Object.entries(this.statusIdsByState)) {
                if (ids.includes(statusId)) return state;
            }
        }
        const name = (this.getString(json, "status_nome") || "").trim().toLowerCase();
        switch (name) {
            case "ativo":
            case "em andamento": return MangaState.ONGOING;
            case "concluido":
            case "concluído": return MangaState.FINISHED;
            case "hiato":
            case "pausado": return MangaState.PAUSED;
            case "cancelado": return MangaState.ABANDONED;
            default: return undefined;
        }
    }

    parseManga(json) {
        const id = parseInt(json && json.id, 10);
        if (!(id > 0)) return null;
        const title = this.getString(json, "nome", "title");
        if (!title) return null;
        const slug = this.getString(json, "slug");
        const formatId = json && json.formato_id != null ? String(json.formato_id) : null;
        const cover = this.getString(json, "imagem", "coverImage");
        const relUrl = this.buildInternalMangaUrl(String(id), slug);
        return new Manga({
            id: relUrl,
            url: relUrl,
            publicUrl: `https://${this.domain}/${this.webMangaPathSegment}/${slug || id}`,
            coverUrl: cover ? this.toAbsoluteCdnUrl(cover) : "",
            title,
            description: this.getString(json, "descricao") || "",
            tags: this.parseTags(json && json.tags),
            state: this.parseState(json),
            authors: [],
            source: this.source,
            contentRating: (formatId && this.adultFormatIds.includes(formatId)) || this.source.isNsfw
                ? ContentRating.ADULT
                : ContentRating.SAFE,
        });
    }

    parseTopManga(json) {
        const id = parseInt(json && json.id, 10);
        if (!(id > 0)) return null;
        const title = this.getString(json, "title", "nome");
        if (!title) return null;
        const cover = this.getString(json, "coverImage", "imagem");
        const relUrl = this.buildInternalMangaUrl(String(id), null);
        return new Manga({
            id: relUrl,
            url: relUrl,
            publicUrl: `https://${this.domain}/${this.webMangaPathSegment}/${id}`,
            coverUrl: cover ? this.toAbsoluteCdnUrl(cover) : "",
            title,
            source: this.source,
            contentRating: this.source.isNsfw ? ContentRating.ADULT : ContentRating.SAFE,
        });
    }

    parseChapters(json, slug) {
        const mangaId = parseInt(json && json.id, 10);
        if (!(mangaId > 0)) return [];
        const arr = (json && json.capitulos) || [];
        if (!Array.isArray(arr)) return [];
        const chapters = [];
        for (const ch of arr) {
            const numberRaw = this.getString(ch, "numero");
            if (numberRaw == null) continue;
            const numberFormatted = this.formatChapterNumber(numberRaw);
            const rawName = this.getString(ch, "nome");
            const title = (rawName && rawName.toLowerCase() !== `cap. ${numberFormatted}`.toLowerCase())
                ? rawName
                : null;
            chapters.push(new MangaChapter({
                id: `${mangaId}_${numberFormatted}`,
                url: this.buildInternalChapterUrl(String(mangaId), numberFormatted, slug),
                title,
                number: parseFloat(numberRaw) || 0,
                volume: 0,
                scanlator: null,
                branch: null,
                uploadDate: this.parseApiDate(this.getString(ch, "criado_em", "atualizado_em")),
                source: this.source,
            }));
        }
        // Oldest first.
        chapters.sort((a, b) => a.number - b.number);
        return chapters;
    }

    parseApiDate(dateString) {
        if (!dateString) return 0;
        const t = Date.parse(dateString);
        return Number.isNaN(t) ? 0 : t;
    }

    // ---- public API --------------------------------------------------------

    async getListPage(page, order, filter) {
        filter = filter || {};
        const hasQuery = filter.query && String(filter.query).trim().length > 0;
        const hasTags = filter.tags && filter.tags.length;
        const hasStates = filter.states && filter.states.length;
        const isEmpty = !hasQuery && !hasTags && !hasStates;

        if (isEmpty && order === SortOrder.POPULARITY) {
            return this.getPopularPage(page);
        }
        if (isEmpty) {
            return this.getLatestPage(page);
        }
        return this.search(page, filter);
    }

    async getPopularPage(page) {
        if (page > 1) return [];
        const res = await this.requestJson(this.apiUrl("obras/top10/views?periodo=total"));
        const arr = (res && res.obras) || [];
        return Array.isArray(arr) ? arr.map((j) => this.parseTopManga(j)).filter(Boolean) : [];
    }

    async getLatestPage(page) {
        const res = await this.requestJson(
            this.apiUrl(`capitulos/recentes?pagina=${page}&limite=${this.latestPageSize}`),
        );
        const arr = (res && res.obras) || [];
        if (!Array.isArray(arr)) return [];
        const seen = new Set();
        const out = [];
        for (const j of arr) {
            const m = this.parseManga(j);
            if (m && !seen.has(m.url)) {
                seen.add(m.url);
                out.push(m);
            }
        }
        return out;
    }

    async search(page, filter) {
        const limit = (filter.query && String(filter.query).trim()) ? this.searchPageSize : this.latestPageSize;
        let url = this.apiUrl(`obras?pagina=${page}`) + `&limite=${limit}`;
        const q = filter.query && String(filter.query).trim();
        if (q) url += `&busca=${encodeURIComponent(q)}`;
        if (filter.tags && filter.tags.length) {
            url += `&tag_ids=${filter.tags.map((t) => encodeURIComponent(t.key)).join(",")}`;
        }
        if (filter.states && filter.states.length) {
            const ids = this.statusIdsByState[filter.states[0]];
            if (ids && ids.length) url += `&status_id=${ids.join(",")}`;
        }
        const res = await this.requestJson(url);
        const arr = (res && res.obras) || [];
        return Array.isArray(arr) ? arr.map((j) => this.parseManga(j)).filter(Boolean) : [];
    }

    async getDetails(manga) {
        const mangaId = this.extractMangaId(manga.url);
        const res = await this.requestJson(this.apiUrl(`obras/${mangaId}`));
        const item = (res && (res.obra || res.data || res.dados)) || res || {};
        const parsed = this.parseManga(item) || manga;
        const slug = this.getString(item, "slug") || "";
        const chapters = this.parseChapters(item, slug);
        return new Manga({
            ...manga,
            title: (parsed.title && parsed.title.trim()) || manga.title,
            url: parsed.url || manga.url,
            publicUrl: parsed.publicUrl || manga.publicUrl,
            coverUrl: parsed.coverUrl || manga.coverUrl,
            largeCoverUrl: parsed.coverUrl || manga.largeCoverUrl || manga.coverUrl,
            description: parsed.description || manga.description,
            tags: (parsed.tags && parsed.tags.length) ? parsed.tags : manga.tags,
            authors: (parsed.authors && parsed.authors.length) ? parsed.authors : manga.authors,
            state: parsed.state || manga.state,
            contentRating: parsed.contentRating || manga.contentRating,
            source: this.source,
            chapters,
        });
    }

    async getPages(chapter) {
        const mangaId = this.extractMangaId(chapter.url);
        const number = this.extractChapterNumber(chapter.url);
        const res = await this.requestJson(
            this.apiUrl(`obras/${mangaId}/capitulos/${encodeURIComponent(number)}`),
        );
        const item = (res && (res.capitulo || res.data || res.dados)) || res || {};
        const paginas = item && item.paginas;
        if (!Array.isArray(paginas)) return [];
        const pages = [];
        for (const p of paginas) {
            const raw = this.getString(p, "cdn_id", "imagem", "image", "src", "link", "path", "arquivo");
            if (!raw) continue;
            const imageUrl = this.toAbsoluteCdnUrl(raw);
            pages.push(new MangaPage({
                id: imageUrl,
                url: imageUrl,
                source: this.source,
            }));
        }
        // Order by the numeric suffix of `.../pagina_NNN.ext`.
        pages.sort((a, b) => {
            const na = parseInt((String(a.url).split("/pagina_")[1] || "").split(".")[0], 10);
            const nb = parseInt((String(b.url).split("/pagina_")[1] || "").split(".")[0], 10);
            return (Number.isNaN(na) ? Number.MAX_SAFE_INTEGER : na) - (Number.isNaN(nb) ? Number.MAX_SAFE_INTEGER : nb);
        });
        return pages;
    }
}
