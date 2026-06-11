import { MadaraParser } from './madara.js';
import { MangaReaderParser } from './mangareader.js';
import { ZeistMangaParser } from './zeistmanga.js';
import { OneMangaParser } from './onemanga.js';
import { HotComicsParser } from './hotcomics.js';
import { WpComicsParser } from './wpcomics.js';
import { PizzaReaderParser } from './pizzareader.js';
import { KeyoappParser } from './keyoapp.js';
import { FoolSlideParser } from './foolslide.js';
import { LilianaParser } from './liliana.js';
import { MadthemeParser } from './madtheme.js';
import { ScanParser } from './scan.js';
import { IkenParser } from './iken.js';
import { MmrcmsParser } from './mmrcms.js';
import { CupFoxParser } from './cupfox.js';
import { FmreaderParser, WeLoveMangaParser } from './fmreader.js';
import { AnimeBootstrapParser } from './animebootstrap.js';
import { GuyaParser } from './guya.js';
import { MangaWorldParser } from './mangaworld.js';
import { MangAdventureParser } from './mangadventure.js';
import { InitMangaParser } from './initmanga.js';
import { FuzzyDoodleParser } from './fuzzydoodle.js';
import { UzayMangaParser } from './uzaymanga.js';
import { ComicasoParser } from './comicaso.js';
import { MangoThemeParser } from './mangotheme.js';
import { ZMangaParser } from './zmanga.js';
import { LikeMangaParser } from './likemanga.js';
import { SinmhParser } from './sinmh.js';
import { MangaBoxParser } from './mangabox.js';
import { MangaFireParser } from './mangafire.js';
import { nyoraId } from './base.js';
export { SortOrder } from './base.js';

const FAMILIES = {
  MadaraParser,
  MangaReaderParser,
  ZeistMangaParser,
  OneMangaParser,
  HotComicsParser,
  WpComicsParser,
  PizzaReaderParser,
  KeyoappParser,
  FoolSlideParser,
  LilianaParser,
  MadthemeParser,
  ScanParser,
  IkenParser,
  MmrcmsParser,
  CupFoxParser,
  FmreaderParser,
  WeLoveMangaParser,
  AnimeBootstrapParser,
  GuyaParser,
  MangaWorldParser,
  MangAdventureParser,
  InitMangaParser,
  FuzzyDoodleParser,
  UzayMangaParser,
  ComicasoParser,
  MangoThemeParser,
  ZMangaParser,
  LikeMangaParser,
  SinmhParser,
  MangaBoxParser,
  MangaFireParser,
};

let sourcesPromise = null;

export async function getAllSources() {
  if (!sourcesPromise) {
    sourcesPromise = fetch(new URL('./sources.json', import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} loading sources.json`);
        return res.json();
      });
  }
  return sourcesPromise;
}

export async function getParser(sourceId, context) {
  const sources = await getAllSources();
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return null;

  const ParserClass = FAMILIES[source.family];
  if (!ParserClass) return null;

  const parser = new ParserClass(context, source, source.domain);
  if (source.overrides) {
    Object.assign(parser, source.overrides);
  }
  return stampIds(parser, source.id);
}

/**
 * Centralised id stamping — mirrors the bundle's index.js. Every manga/chapter the parser
 * emits gets the canonical [nyoraId] (shared source token + parser-relative url), so the web
 * SPA produces the SAME ids as iOS/Android/Mac and the data syncs.
 */
function stampIds(parser, token) {
  const stampChapter = (c) => {
    if (c && c.url != null) c.id = nyoraId(token, ' chapter ' + c.url);
    return c;
  };
  const stampManga = (m) => {
    if (m && m.url != null) {
      m.id = nyoraId(token, m.url);
      if (Array.isArray(m.chapters)) m.chapters.forEach(stampChapter);
    }
    return m;
  };
  const wrap = (name, after) => {
    const fn = parser[name];
    if (typeof fn !== 'function') return;
    parser[name] = async function (...args) {
      const result = await fn.apply(this, args);
      after(result);
      return result;
    };
  };
  wrap('getListPage', (r) => { if (Array.isArray(r)) r.forEach(stampManga); });
  wrap('getDetails', (r) => { stampManga(r); });
  wrap('getChapters', (r) => { if (Array.isArray(r)) r.forEach(stampChapter); });
  return parser;
}
