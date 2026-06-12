// screens/suggestions.js — "For You": AniList Trending discovery feed.
//
// Mirrors the nyora-linux SuggestionsScreen: fetch the top TRENDING manga from
// AniList with NO auth via a direct CORS-allowed GraphQL POST to
// https://graphql.anilist.co, then render a premium cover grid (cover, title,
// score chip, lead genre). Tapping a card runs a global search for that title
// (router.navigate('search', { q: title })) so the user can resolve it against
// whichever sources they have installed.
//
// AniList sends permissive CORS headers, so the browser allows this cross-origin
// call directly — no proxy and no server endpoint needed. This is the sole
// cross-origin direct fetch in the SPA; everything else goes through same-origin
// api.js.
//
// Loading shows a skeleton grid (never a blank screen); a failed fetch lands on
// an inline errorBox with a Retry button. Navigation can interrupt the in-flight
// request, so a per-render token guards against a stale response painting over a
// newer view.

import {
  el, skeletonCard, errorBox, emptyState,
  sectionHeader, chip, icon, btn,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = {
  title: 'Discover',
  nav: true,
  icon: 'trending',
  order: 5,
};

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const ANILIST_QUERY =
  'query{Page(perPage:30){media(type:MANGA,sort:TRENDING_DESC){' +
  'id title{romaji english} coverImage{large} averageScore genres}}}';

// Bump on every render() so a slow fetch from a previous view can't overwrite
// the section element after the user has navigated away and back.
let renderToken = 0;

export function render(view, _params) {
  view.replaceChildren();

  const section = el('section', { class: 'suggest-section' });
  view.append(section);

  load(section);
}

async function load(section) {
  const token = ++renderToken;

  section.replaceChildren(
    sectionHeader('Trending on AniList', icon('trending')),
    skeletonGrid(18),
  );

  let media;
  try {
    media = await fetchAnilistTrending();
  } catch (err) {
    if (token !== renderToken) return;
    section.replaceChildren(
      sectionHeader('Trending on AniList', icon('trending')),
      errorBox(`Couldn't reach AniList: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(section) }),
      ),
    );
    return;
  }

  if (token !== renderToken) return;

  if (!media.length) {
    section.replaceChildren(
      sectionHeader('Trending on AniList', icon('trending')),
      emptyState('AniList has nothing trending right now — check back soon.'),
      el('div', { class: 'center', style: { marginTop: '14px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => load(section) }),
      ),
    );
    return;
  }

  const grid = el('div', { class: 'grid' });
  for (const item of media) grid.appendChild(trendingCard(item));
  section.replaceChildren(
    sectionHeader('Trending on AniList', icon('trending')),
    grid,
  );
}

// Direct GraphQL POST — AniList sends permissive CORS headers, so the browser
// allows this cross-origin call (the sole exception in the SPA).
async function fetchAnilistTrending() {
  const res = await fetch(ANILIST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: ANILIST_QUERY }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const list = json && json.data && json.data.Page && json.data.Page.media;
  return Array.isArray(list) ? list : [];
}

function anilistTitle(item) {
  const t = item && item.title;
  return (t && (t.english || t.romaji)) || 'Untitled';
}

// Premium cover card: lazy proxied cover, score + lead-genre chips floated over
// the artwork, title below. Tapping runs a global search for the title.
function trendingCard(item) {
  const title = anilistTitle(item);
  const cover = (item.coverImage && item.coverImage.large) || '';
  const score = typeof item.averageScore === 'number' ? item.averageScore : null;
  const genre = Array.isArray(item.genres) && item.genres.length ? item.genres[0] : null;

  const coverWrap = el('div', { class: 'cover' });
  // AniList's CDN serves images with permissive CORS — load them DIRECTLY, not
  // through the Nyora image proxy (which is for hotlink-protected source CDNs).
  const src = cover;
  if (src) {
    const img = el('img', {
      loading: 'lazy',
      decoding: 'async',
      alt: title,
      src,
    });
    img.addEventListener('error', () => { img.style.display = 'none'; });
    coverWrap.appendChild(img);
  }

  // Score / genre micro-tags over the cover, echoing the desktop caption row.
  const tags = [];
  if (score != null) tags.push(chip(`${score}%`, { class: 'status-completed' }));
  if (genre) tags.push(chip(genre));
  if (!tags.length) tags.push(chip('Trending'));
  coverWrap.appendChild(
    el('div', {
      class: 'chips',
      style: { position: 'absolute', left: '8px', right: '8px', bottom: '8px', gap: '6px' },
    }, ...tags),
  );

  const node = el(
    'div',
    { class: 'card', role: 'button', tabindex: '0' },
    coverWrap,
    el('div', { class: 'title', title }, title),
  );
  const go = () => router.navigate('search', { q: title });
  node.addEventListener('click', go);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
  });
  return node;
}

function skeletonGrid(n) {
  const grid = el('div', { class: 'grid' });
  for (let i = 0; i < n; i++) grid.appendChild(skeletonCard());
  return grid;
}
