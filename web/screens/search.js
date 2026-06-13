// screens/search.js — GLOBAL SEARCH results.

import { api } from '../core/api.js';
import {
  el, card, btn, chip, spinner, skeletonCard, emptyState, errorBox, icon, langLabel,
} from '../core/ui.js';
import { router } from '../core/store.js';

export const meta = { title: 'Search', nav: false, icon: 'search', order: 99 };

const PER_SOURCE_LIMIT = 12;
const MAX_SOURCES = 24;
const SKELETONS = 4;

export function render(view, params) {
  view.replaceChildren();

  const runState = { token: 0, sections: [], done: 0, total: 0, sawError: false };
  let query = (params && params.q != null ? String(params.q) : '').trim();

  const title = el('h1', { class: 'page-title', style: { marginBottom: '8px' } }, query ? `Results for “${query}”` : 'Global Search');
  const searchInput = el('input', {
    id: 'searchPageInput',
    type: 'search',
    value: query,
    placeholder: 'Search all sources',
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const searchForm = el('form', {
    class: 'search-page-header',
    onSubmit: (e) => {
      e.preventDefault();
      const next = searchInput.value.trim();
      if (!next) {
        router.navigate('search');
        return;
      }
      router.navigate('search', { q: next });
    },
  },
    el('div', { class: 'search-field-v2' },
      icon('search'),
      searchInput,
      btn('Search', { variant: 'accent', class: 'btn-sm', type: 'submit' }),
    ),
  );
  const status = el('div', { class: 'search-status', style: { marginBottom: '24px' } });
  const results = el('div', { class: 'search-results' });

  view.append(title, searchForm, status, results);
  requestAnimationFrame(() => {
    if (!query || document.body.dataset.route === 'search') {
      searchInput.focus({ preventScroll: true });
      try { searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length); } catch { /* ignore */ }
    }
  });

  function sourceSection(src) {
    const sid = src.id;
    const lang = (src.lang || '').toUpperCase();
    const count = el('span', { class: 'chip btn-sm' }, spinner());

    const head = el('div', { class: 'search-result-header' },
      el('div', { class: 'source-meta' },
        el('div', { class: 'medallion-sm' }, lang.slice(0, 2) || '??'),
        el('div', null,
          el('h3', { class: 'source-name' }, src.name || sid),
          el('div', { class: 'source-sub' }, langLabel(src))
        )
      ),
      count
    );

    const bodyGrid = el('div', { class: 'grid dense' });
    for (let i = 0; i < SKELETONS; i++) bodyGrid.appendChild(skeletonCard());

    const section = el('section', { class: 'search-source-card-minimal' }, head, bodyGrid);

    return {
      node: section,
      resolve(entries, error) {
        if (error) {
          count.replaceChildren(document.createTextNode('Failed'));
          const box = errorBox(error);
          box.appendChild(btn('Retry', { variant: 'ghost', class: 'btn-sm', onClick: () => retryOne(src) }));
          section.replaceChildren(head, box);
          return;
        }
        const list = Array.isArray(entries) ? entries.slice(0, PER_SOURCE_LIMIT) : [];
        if (!list.length) {
          section.remove();
          return;
        }
        count.textContent = list.length + (list.length >= PER_SOURCE_LIMIT ? '+' : '');
        const grid = el('div', { class: 'grid dense' });
        for (const manga of list) {
          grid.appendChild(card(manga, (m) => router.navigate('details', { sid, url: m.url })));
        }
        section.replaceChildren(head, grid);
      },
    };
  }

  function retryOne(src) {
    const token = runState.token;
    const entry = runState.sections.find(s => s.src.id === src.id);
    if (!entry) return;
    const fresh = sourceSection(src);
    entry.node.replaceWith(fresh.node);
    entry.node = fresh.node;
    entry.section = fresh;
    searchOne(src, fresh, token);
  }

  async function searchOne(src, section, token) {
    try {
      const res = await api.search(src.id, query, 1);
      if (token !== runState.token) return;
      section.resolve((res && res.entries) || [], null);
    } catch (e) {
      if (token !== runState.token) return;
      section.resolve(null, e.message || String(e));
    } finally {
      if (token === runState.token) tallyDone();
    }
  }

  function tallyDone() {
    runState.done++;
    if (runState.done < runState.total) {
      status.replaceChildren(spinner(), el('span', null, `Searching ${runState.total} sources...`));
      return;
    }
    const hits = runState.sections.filter((s) => s.node.parentNode).length;
    status.replaceChildren(
      el('span', { class: 'chip' }, hits > 0 ? `Found matches in ${hits} sources` : `No matches found for "${query}"`)
    );
  }

  function renderEmpty() {
    title.textContent = 'Global Search';
    status.replaceChildren();
    results.replaceChildren(emptyState('Search across every installed source', 'search'));
  }

  async function runSearch() {
    const token = ++runState.token;
    runState.sections = []; runState.done = 0; runState.sawError = false;
    status.replaceChildren(spinner(), el('span', null, 'Searching...'));
    results.replaceChildren();

    try {
      const res = await api.listSources();
      if (token !== runState.token) return;
      let sources = (res && res.sources || []).filter(s => s.isInstalled);
      if (!sources.length) { results.replaceChildren(emptyState('No sources installed', 'compass')); return; }
      
      sources.sort((a,b) => (b.isPinned?1:0) - (a.isPinned?1:0));
      sources = sources.slice(0, MAX_SOURCES);
      runState.total = sources.length;

      const frag = document.createDocumentFragment();
      runState.sections = sources.map(src => {
        const sec = sourceSection(src);
        frag.appendChild(sec.node);
        return { src, section: sec, node: sec.node };
      });
      results.appendChild(frag);

      for (const entry of runState.sections) searchOne(entry.src, entry.section, token);
    } catch (e) { results.replaceChildren(errorBox(e.message)); }
  }

  if (query) runSearch(); else renderEmpty();
}

export default { meta, render };
