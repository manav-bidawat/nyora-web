// screens/tracker.js — AniList tracker (redesigned for design-system v2).
//
// Mirrors nyora-linux TrackerScreen: a persisted OAuth access token plus a
// MANGA search against AniList (proxied through the same-origin server, which
// attaches the Bearer token). Picking a result opens a tiny scrobble form
// (status + progress) that POSTs to api.anilistScrobble.
//
// The token lives in store (store.set({anilistToken}); store.get().anilistToken)
// so it survives reloads and is shared with the reader's auto-scrobble. The
// token is never sent cross-origin from here — api.anilistSearch / scrobble go
// to our own server, which forwards to graphql.anilist.co with the Bearer.
//
// Everything degrades gracefully: no token -> inline hint + disabled search;
// search errors -> errorBox with retry; empty results -> emptyState. Async
// search is stale-guarded with a token counter so fast re-searches/navigation
// never paint outdated results.
//
// UI: token lives in a .settings-section with a .field input + .btn-accent
// "Validate & save", a "Linked"/"Not linked" .chip status, and a search bar
// that feeds a card .grid of AniList covers. Each result card opens the
// scrobble modal (status .select + a stepper for chapters read).

import { api } from '../core/api.js';
import {
  el, proxyImage, toast, spinner, sectionHeader,
  emptyState, errorBox, btn, iconBtn, chip, card, modal, stepper, icon, skeletonCard,
} from '../core/ui.js';
import { store } from '../core/store.js';

export const meta = {
  title: 'Tracker',
  nav: false,
  icon: 'anilist',
  order: 99,
};

// AniList MediaListStatus enum values + friendly labels.
const STATUS_OPTIONS = [
  { value: 'CURRENT', label: 'Reading' },
  { value: 'PLANNING', label: 'Plan to read' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'DROPPED', label: 'Dropped' },
  { value: 'REPEATING', label: 'Re-reading' },
];

// Stale-guard for async search: each runSearch() bumps this; only the latest
// run is allowed to paint into resultsSection.
let searchToken = 0;

export function render(view, params) {
  view.replaceChildren();

  const initialTitle = (params && params.title) || '';

  // Persistent regions, each re-rendered independently.
  const tokenSection = el('section', { class: 'settings-section' });
  const searchSection = el('section', { class: 'settings-section' });
  const resultsSection = el('section');

  view.append(
    el('div', { class: 'page-title' }, 'AniList Tracker'),
    tokenSection,
    searchSection,
    resultsSection,
  );

  const refreshSearch = () => renderSearchBox(searchSection, resultsSection, currentSearchValue(searchSection));
  renderTokenPanel(tokenSection, refreshSearch);
  renderSearchBox(searchSection, resultsSection, initialTitle);

  // Until a search runs, show a hint in the results region.
  resultsSection.replaceChildren(
    emptyState('Search AniList above to find a title to track.'),
  );

  // Arrived with a prefilled title and a token already saved -> auto-search.
  if (initialTitle.trim() && hasToken()) {
    runSearch(resultsSection, initialTitle.trim());
  }
}

// ---- token state -------------------------------------------------------

function hasToken() {
  const t = store.get().anilistToken;
  return typeof t === 'string' && t.trim().length > 0;
}

function currentSearchValue(searchSection) {
  const input = searchSection.querySelector('input[type="text"]');
  return input ? input.value : '';
}

// ---- token panel -------------------------------------------------------

function renderTokenPanel(section, onTokenChange) {
  const linked = hasToken();

  const status = chip(linked ? 'Linked' : 'Not linked', {
    class: (linked ? 'active ' : '') + 'status-chip',
  });
  status.style.pointerEvents = 'none';

  const input = el('input', {
    type: 'password',
    placeholder: 'Paste your AniList OAuth access token…',
    value: store.get().anilistToken || '',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  let revealed = false;
  const revealBtn = iconBtn('eye', () => {
    revealed = !revealed;
    input.type = revealed ? 'text' : 'password';
    revealBtn.replaceChildren(icon(revealed ? 'eyeOff' : 'eye'));
    revealBtn.title = revealed ? 'Hide token' : 'Show token';
  }, 'Show token');

  const inputRow = el(
    'div',
    { class: 'row', style: { alignItems: 'stretch', gap: '8px' } },
    el('div', { class: 'field', style: { flex: '1 1 240px', marginBottom: '0' } }, input),
    revealBtn,
  );

  // Validate & save: persist the trimmed token, then confirm it works against
  // AniList with a lightweight search so the user gets real feedback (not just
  // "saved"). Keeps the existing store-based persistence intact.
  const saveBtn = btn('Validate & save', {
    primary: true,
    icon: 'check',
    onClick: () => validateAndSave(),
  });

  const clearBtn = btn('Clear', {
    variant: 'ghost',
    class: 'btn-sm',
    icon: 'trash',
    disabled: !linked,
    onClick: () => {
      store.set({ anilistToken: '' });
      toast('Token cleared');
      renderTokenPanel(section, onTokenChange);
      if (onTokenChange) onTokenChange();
    },
  });

  async function validateAndSave() {
    const value = input.value.trim();
    if (!value) {
      store.set({ anilistToken: '' });
      toast('Token cleared');
      renderTokenPanel(section, onTokenChange);
      if (onTokenChange) onTokenChange();
      return;
    }
    // Persist immediately (matches old behaviour: save even if validation
    // hiccups), then probe AniList.
    store.set({ anilistToken: value });
    const original = saveBtn.querySelector('span');
    const originalText = original ? original.textContent : 'Validate & save';
    saveBtn.disabled = true;
    if (original) original.textContent = 'Validating…';
    try {
      await api.anilistSearch('one piece', value);
      toast('Token validated and saved');
    } catch (err) {
      // Saved, but the probe failed — surface it without discarding the token.
      toast(`Saved, but validation failed: ${err.message || err}`);
    } finally {
      saveBtn.disabled = false;
      if (original) original.textContent = originalText;
      renderTokenPanel(section, onTokenChange);
      if (onTokenChange) onTokenChange();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      validateAndSave();
    }
  });

  const hint = el(
    'p',
    { class: 'hint', style: { fontSize: '12.5px', lineHeight: '1.55', marginTop: '4px' } },
    'Full OAuth web flow is planned for a future release. For now, paste an OAuth ' +
      'access token from anilist.co/settings/developer. Once a token is saved, ' +
      'per-chapter scrobble fires automatically as you read.',
  );

  section.replaceChildren(
    sectionHeader('Access Token', status),
    inputRow,
    el('div', { class: 'row', style: { marginTop: '12px', gap: '8px' } }, saveBtn, clearBtn),
    hint,
  );
}

// ---- search box --------------------------------------------------------

function renderSearchBox(section, resultsSection, prefill) {
  const linked = hasToken();

  const input = el('input', {
    type: 'text',
    placeholder: 'Search AniList for a manga…',
    value: prefill || '',
    autocomplete: 'off',
    disabled: !linked,
  });

  const submit = () => {
    if (!hasToken()) {
      toast('Save an AniList token first');
      return;
    }
    const q = input.value.trim();
    if (!q) {
      toast('Enter a title to search');
      return;
    }
    runSearch(resultsSection, q);
  };

  const searchBtn = btn('Search', {
    primary: true,
    icon: 'search',
    disabled: !linked,
    onClick: submit,
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  const row = el(
    'div',
    { class: 'row', style: { alignItems: 'stretch', gap: '8px' } },
    el('div', { class: 'field', style: { flex: '1 1 240px', marginBottom: '0' } }, input),
    searchBtn,
  );

  const kids = [sectionHeader('Find a title'), row];
  if (!linked) {
    kids.push(
      el('p', { class: 'hint', style: { fontSize: '12.5px', marginTop: '8px' } },
        'Save an AniList access token above to enable search.'),
    );
  }
  section.replaceChildren(...kids);
}

// ---- search execution --------------------------------------------------

async function runSearch(resultsSection, query) {
  const myToken = ++searchToken;

  // Skeleton grid placeholder while the request is in flight (never blank).
  const skeletons = el('div', { class: 'grid dense' });
  for (let i = 0; i < 8; i++) skeletons.appendChild(skeletonCard());
  resultsSection.replaceChildren(
    sectionHeader(`Searching “${query}”…`),
    skeletons,
  );

  const token = (store.get().anilistToken || '').trim();
  if (!token) {
    if (myToken !== searchToken) return;
    resultsSection.replaceChildren(
      errorBox('No AniList token saved. Add one above to search.'),
    );
    return;
  }

  let media;
  try {
    const raw = await api.anilistSearch(query, token);
    media = (raw && raw.data && raw.data.Page && raw.data.Page.media) || [];
  } catch (err) {
    if (myToken !== searchToken) return;
    resultsSection.replaceChildren(
      sectionHeader('Results'),
      errorBox(`AniList search failed: ${err.message || err}`),
      el('div', { class: 'center', style: { marginTop: '12px' } },
        btn('Retry', { variant: 'ghost', icon: 'refresh', onClick: () => runSearch(resultsSection, query) }),
      ),
    );
    return;
  }

  if (myToken !== searchToken) return;

  if (!media.length) {
    resultsSection.replaceChildren(
      sectionHeader('Results'),
      emptyState(`No AniList titles found for “${query}”.`),
    );
    return;
  }

  const grid = el('div', { class: 'grid dense' });
  for (const m of media) grid.appendChild(mediaCard(m));

  const count = media.length;
  resultsSection.replaceChildren(
    sectionHeader(
      'Results',
      chip(`${count} title${count === 1 ? '' : 's'}`),
    ),
    grid,
  );
}

// ---- a single AniList media card --------------------------------------
//
// Reuses the shared card() cover idiom (proxied lazy image, 2:3 cover, title
// clamp). We adapt the AniList media shape into the {title, coverUrl, isNsfw}
// the card() helper expects, then layer a score chip onto the cover and wire
// the click to the scrobble modal.

function mediaCard(media) {
  const t = (media && media.title) || {};
  const primary = t.english || t.romaji || t.native || 'Untitled';
  const secondary = (t.english && t.romaji && t.romaji !== t.english) ? t.romaji : null;
  const cover = (media.coverImage && media.coverImage.large) || '';
  const score = typeof media.averageScore === 'number' ? media.averageScore : null;
  const chapters = typeof media.chapters === 'number' ? media.chapters : null;
  const isAdult = media.isAdult === true;

  // Build the card via the shared helper so cover styling/behaviour matches the
  // rest of the app, then enrich it.
  const node = card(
    { title: primary, coverUrl: cover, isNsfw: isAdult },
    () => openScrobbleForm(media, primary, chapters),
  );

  // Score badge in the top-right of the cover (mirrors the .badge.nsfw idiom).
  const coverWrap = node.querySelector('.cover');
  if (coverWrap && score != null) {
    coverWrap.appendChild(
      el('span', {
        class: 'badge',
        style: { left: 'auto', right: '8px', display: 'inline-flex', alignItems: 'center', gap: '3px' },
      }, `★ ${(score / 10).toFixed(1)}`),
    );
  }

  // Secondary meta line (romaji + chapter count) under the title.
  const metaBits = [];
  if (chapters != null) metaBits.push(`${chapters} ch`);
  if (secondary) metaBits.push(secondary);
  if (metaBits.length) {
    node.appendChild(
      el('div', {
        class: 'title',
        style: {
          color: 'var(--text-faint)', fontWeight: '450', fontSize: '11.5px',
          marginTop: '-4px', WebkitLineClamp: '1',
        },
        title: metaBits.join(' · '),
      }, metaBits.join(' · ')),
    );
  }

  return node;
}

// ---- scrobble form -----------------------------------------------------

function openScrobbleForm(media, displayTitle, totalChapters) {
  const statusSelect = el(
    'select',
    null,
    ...STATUS_OPTIONS.map((o) => el('option', { value: o.value }, o.label)),
  );

  // Numeric chapters read via the shared stepper pill (never bare +/- buttons).
  const maxCh = totalChapters != null && totalChapters > 0 ? totalChapters : 9999;
  let progressValue = 0;
  const progressStepper = stepper({
    value: 0,
    min: 0,
    max: maxCh,
    step: 1,
    onChange: (v) => { progressValue = v; },
  });

  const body = el(
    'div',
    null,
    el('p', { class: 'desc', style: { marginBottom: '16px', fontWeight: '650', color: 'var(--text)' } }, displayTitle),
    el('div', { class: 'field' }, el('label', null, 'Status'), statusSelect),
    el('div', { class: 'setting-row', style: { padding: '0', border: 'none' } },
      el('div', { class: 'row-main' },
        el('div', { class: 'name' }, 'Chapters read'),
        totalChapters != null
          ? el('div', { class: 'sub' }, `of ${totalChapters} total`)
          : null,
      ),
      el('div', { class: 'row-actions' }, progressStepper),
    ),
  );

  const close = modal({
    title: 'Track on AniList',
    body,
    actions: [
      { label: 'Cancel', variant: 'ghost', onClick: () => {} },
      {
        label: 'Save to AniList',
        primary: true,
        // Return false to KEEP the modal open while the async POST runs; we
        // close() explicitly on success.
        onClick: () => { submitScrobble(); return false; },
      },
    ],
  });

  async function submitScrobble() {
    const token = (store.get().anilistToken || '').trim();
    if (!token) {
      toast('No AniList token saved');
      return;
    }
    const progress = Math.max(0, progressValue || 0);
    const status = statusSelect.value || 'CURRENT';
    const mediaId = media.id;

    try {
      const raw = await api.anilistScrobble({ mediaId, progress, status }, token);
      if (raw && Array.isArray(raw.errors) && raw.errors.length) {
        throw new Error(raw.errors[0].message || 'AniList rejected the update');
      }
      const entry = raw && raw.data && raw.data.SaveMediaListEntry;
      const savedStatus = (entry && entry.status) || status;
      const savedProgress = entry && entry.progress != null ? entry.progress : progress;
      const label = STATUS_OPTIONS.find((o) => o.value === savedStatus);
      toast(`Saved: ${(label && label.label) || savedStatus} · ${savedProgress} ch`);
      close();
    } catch (err) {
      toast(`Scrobble failed: ${err.message || err}`);
    }
  }
}
