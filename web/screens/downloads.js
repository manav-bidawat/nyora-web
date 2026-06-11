// screens/downloads.js — download queue, settings, and offline reader.
//
// Backed by core/downloads.js (the real client-side download engine). The list
// live-updates via downloads.subscribe(); the settings card writes straight
// through to the manager. Completed chapters kept offline can be read in-app or
// saved to the device as CBZ/ZIP.

import { downloads } from '../core/downloads.js';
import { unzipImages } from '../core/zip.js';
import {
  el, $, spinner, emptyState, errorBox, sectionHeader, icon, btn, iconBtn,
  toast, stepper, segmented, confirmDialog,
} from '../core/ui.js';

export const meta = {
  title: 'Downloads',
  nav: false,
  icon: 'download',
  order: 80,
};

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

let _unsub = null;
let _readerUrls = [];

export function render(view, _params) {
  if (_unsub) { _unsub(); _unsub = null; }
  revokeReaderUrls();
  view.replaceChildren();

  const header = sectionHeader('Downloads');
  const settings = buildSettings();
  const queueWrap = el('div', { class: 'downloads-host' });
  view.append(header, settings.node, queueWrap);

  const renderQueue = () => paintQueue(view, queueWrap);
  renderQueue();

  _unsub = downloads.subscribe(() => {
    if (!queueWrap.isConnected) { if (_unsub) { _unsub(); _unsub = null; } return; }
    renderQueue();
    settings.refreshStorage();
  });

  // Deterministic cleanup when navigating away (app.js dispatch calls this).
  view.__downloadsTeardown = () => {
    if (_unsub) { _unsub(); _unsub = null; }
    revokeReaderUrls();
  };
}

// ── Settings card ──────────────────────────────────────────────────────────

function buildSettings() {
  const s = downloads.getSettings();
  const section = el('section', { class: 'settings-section' });
  section.append(el('h2', null, 'Download settings'));

  // Format
  const formatSeg = segmented(
    [{ label: 'CBZ', value: 'CBZ' }, { label: 'ZIP', value: 'ZIP' }],
    s.format,
    (v) => { downloads.saveSettings({ format: v }); toast(`Saving as ${v}`); },
  );
  section.append(settingRow('Archive format', 'CBZ opens in comic readers; ZIP is the same file, renamed.', formatSeg));

  // Max concurrent chapters
  section.append(settingRow('Concurrent chapters', 'Chapters downloaded in parallel.',
    stepper({
      value: s.maxConcurrent, min: 1, max: 5,
      onChange: (v) => downloads.saveSettings({ maxConcurrent: v }),
    })));

  // Parallel page downloads
  section.append(settingRow('Parallel pages', 'Page images fetched at once per chapter.',
    stepper({
      value: s.imageConcurrency, min: 1, max: 8,
      onChange: (v) => downloads.saveSettings({ imageConcurrency: v }),
    })));

  // Retries
  section.append(settingRow('Retries per page', 'Re-attempts before a page is skipped.',
    stepper({
      value: s.retries, min: 0, max: 5,
      onChange: (v) => downloads.saveSettings({ retries: v }),
    })));

  // Keep offline
  section.append(settingRow('Keep for offline reading', 'Store downloaded chapters in this browser.',
    switchToggle(s.keepOffline, (on) => {
      downloads.saveSettings({ keepOffline: on });
      if (!on) toast('New downloads will not be kept offline');
    })));

  // Auto-save to device
  section.append(settingRow('Auto-save to device', 'Also download each finished file to your computer.',
    switchToggle(s.saveToDevice, (on) => downloads.saveSettings({ saveToDevice: on }))));

  // Storage usage + clear actions
  const storageText = el('div', { class: 'sub' });
  const clearDone = btn('Clear finished', {
    variant: 'ghost', icon: 'trash', class: 'btn-sm',
    onClick: async () => {
      const res = await downloads.clearCompleted();
      toast(res.removed ? `Cleared ${res.removed}` : 'Nothing to clear');
    },
  });
  const clearAll = btn('Delete all', {
    variant: 'ghost', icon: 'trash', class: 'btn-sm btn-danger',
    onClick: async () => {
      if (!(await confirmDialog('Delete every download, including offline files?'))) return;
      const res = await downloads.clearAll();
      toast(res.removed ? `Deleted ${res.removed}` : 'Nothing to delete');
    },
  });
  const storageRow = el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, 'Offline storage'),
      storageText,
    ),
    el('div', { class: 'row-actions' }, clearDone, clearAll),
  );
  section.append(storageRow);

  const refreshStorage = () => {
    const c = downloads.counts();
    const parts = [];
    if (c.completed) parts.push(`${c.completed} chapter${c.completed === 1 ? '' : 's'}`);
    parts.push(fmtBytes(c.totalBytes));
    storageText.textContent = `${parts.join(' · ')} stored offline`;
  };
  refreshStorage();

  return { node: section, refreshStorage };
}

// ── Queue list ──────────────────────────────────────────────────────────────

function paintQueue(view, host) {
  const rows = downloads.list();
  const active = rows.filter((r) => ACTIVE.has(r.status));
  const finished = rows.filter((r) => !ACTIVE.has(r.status));

  const actions = el('div', { class: 'section-actions' });
  if (active.length) {
    actions.appendChild(btn(`Cancel all (${active.length})`, {
      variant: 'ghost', class: 'btn-danger btn-sm', icon: 'close',
      onClick: () => { downloads.cancelAll(); toast('Cancelling downloads'); },
    }));
  }
  const completed = finished.filter((r) => r.status === 'COMPLETED' && r.offline);
  if (completed.length > 1) {
    actions.appendChild(btn('Save all', {
      variant: 'ghost', class: 'btn-sm', icon: 'download',
      onClick: async () => {
        toast('Bundling…');
        const res = await downloads.saveBundle(completed.map((r) => r.id), 'nyora-downloads');
        toast(res.ok ? `Saved ${res.count} chapters` : 'Nothing to save');
      },
    }));
  }

  const header = el('div', { class: 'section-header' },
    el('h2', null, `Queue${rows.length ? ` (${rows.length})` : ''}`),
    actions,
  );

  if (!rows.length) {
    host.replaceChildren(header, emptyState('No downloads yet. Open a manga and tap Download.'));
    return;
  }

  const list = el('div', { class: 'list' });
  for (const job of rows) list.appendChild(downloadRow(view, job));
  host.replaceChildren(header, list);
}

function downloadRow(view, job) {
  const status = job.status || 'QUEUED';
  const total = num(job.totalPages, 0);
  const done = num(job.completedPages, 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const main = el('div', { class: 'row-main' },
    el('div', { class: 'name', title: job.mangaTitle || '' }, job.mangaTitle || 'Untitled'),
    el('div', { class: 'sub', title: job.chapterTitle || '' }, job.chapterTitle || ''),
  );

  if (status === 'RUNNING' || status === 'QUEUED') {
    main.appendChild(el('div', { class: 'progress' },
      el('span', { style: { width: `${status === 'RUNNING' && total > 0 ? pct : (status === 'RUNNING' ? 6 : 0)}%` } })));
    main.appendChild(el('div', { class: 'sub dl-meta' },
      status === 'RUNNING'
        ? (total > 0 ? `${done} / ${total} pages · ${pct}%` : 'Fetching pages…')
        : 'Queued'));
  } else if (status === 'COMPLETED') {
    main.appendChild(el('div', { class: 'sub dl-meta' },
      `${num(job.completedPages)} pages · ${fmtBytes(job.bytes)}`
      + (job.offline ? ' · offline' : (job.savedToDevice ? ' · saved to device' : ''))));
    if (job.warning) {
      main.appendChild(el('div', { class: 'sub dl-warn' }, job.warning));
    }
  } else if (status === 'FAILED') {
    main.appendChild(el('div', { class: 'sub dl-err' }, job.error || 'Download failed'));
  } else if (status === 'CANCELLED') {
    main.appendChild(el('div', { class: 'sub dl-meta' }, 'Cancelled'));
  }

  const actions = el('div', { class: 'row-actions' }, statusChip(status, job));

  if (ACTIVE.has(status)) {
    actions.appendChild(iconBtn('close', () => { downloads.cancel(job.id); }, 'Cancel'));
  }
  if (status === 'COMPLETED' && job.offline) {
    actions.appendChild(iconBtn('eye', () => openOfflineReader(view, job), 'Read offline'));
    actions.appendChild(iconBtn('download', async () => {
      const res = await downloads.saveToDevice(job.id);
      toast(res.ok ? 'Saved to device' : 'No file to save');
    }, 'Save to device'));
  }
  if (status === 'FAILED' || status === 'CANCELLED' || (status === 'COMPLETED' && job.warning)) {
    actions.appendChild(iconBtn('refresh', () => { downloads.retry(job.id); toast('Retrying'); }, 'Retry'));
  }
  if (!ACTIVE.has(status)) {
    actions.appendChild(iconBtn('trash', () => { downloads.remove(job.id); }, 'Remove'));
  }

  return el('div', { class: 'row-item' }, main, actions);
}

// ── Offline reader ──────────────────────────────────────────────────────────

async function openOfflineReader(view, job) {
  revokeReaderUrls();
  view.replaceChildren(el('div', { class: 'center', style: { padding: '48px 0' } }, spinner()));

  let pages;
  try {
    const blob = await downloads.getBlob(job.id);
    if (!blob) throw new Error('Offline file not found');
    const entries = await unzipImages(blob);
    pages = entries.map((e) => trackUrl(URL.createObjectURL(new Blob([e.bytes]))));
  } catch (err) {
    view.replaceChildren(
      sectionHeader(job.chapterTitle || 'Chapter', iconBtn('back', () => render(view), 'Back')),
      errorBox(`Couldn't open this download: ${err.message || err}`),
    );
    return;
  }

  const back = iconBtn('back', () => render(view), 'Back to downloads');
  const header = el('div', { class: 'section-header' },
    el('h2', null, job.chapterTitle || 'Chapter'),
    el('div', { class: 'section-actions' },
      el('span', { class: 'chip' }, `${pages.length} pages`),
      back,
    ),
  );
  view.replaceChildren(header);

  if (!pages.length) { view.appendChild(emptyState('This download has no readable pages.')); return; }

  const reader = el('div', { class: 'reader webtoon', style: { paddingBottom: '48px' } });
  for (let i = 0; i < pages.length; i++) {
    const img = el('img', { class: 'reader-page', loading: 'lazy', decoding: 'async', alt: `Page ${i + 1}`, src: pages[i] });
    img.addEventListener('error', () => { img.style.display = 'none'; });
    reader.appendChild(img);
  }
  view.appendChild(reader);
}

function trackUrl(url) { _readerUrls.push(url); return url; }
function revokeReaderUrls() {
  for (const u of _readerUrls) { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }
  _readerUrls = [];
}

// ── small helpers ───────────────────────────────────────────────────────────

function settingRow(name, sub, control) {
  return el('div', { class: 'setting-row' },
    el('div', { class: 'row-main' },
      el('div', { class: 'name' }, name),
      sub ? el('div', { class: 'sub' }, sub) : null,
    ),
    el('div', { class: 'row-actions' }, control),
  );
}

function switchToggle(checked, onToggle) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onToggle(input.checked));
  return el('label', { class: 'switch' }, input, el('span', { class: 'slider' }));
}

function statusChip(status, job) {
  const map = { RUNNING: 'Running', QUEUED: 'Queued', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled' };
  let key = (status || '').toLowerCase();
  let label = map[status] || status || 'Unknown';
  if (status === 'COMPLETED' && job && job.warning) { key = 'queued'; label = 'Partial'; }
  return el('span', { class: `chip status-${key}` }, label);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
  return `${(v / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default { meta, render };
