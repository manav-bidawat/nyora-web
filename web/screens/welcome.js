// Nyora Web — first-run welcome / start screen.
//
// A cinematic, anime-inspired night-rain landing shown once on first launch
// when the user isn't signed in and hasn't chosen to continue as a guest.
// Animated rain + atmospheric glow/mist + the occasional lightning flash, over
// a glass auth card. Desktop-first but responsive. Keeps the robust GIS sign-in
// (One-Tap → account-chooser button fallback), guest, and restore actions.

import { el, toast } from '../core/ui.js';
import sync from '../core/sync.js';
import api from '../core/api.js';

const ONBOARD_KEY = 'nyora.web.onboarded.v1';

// Multicolour Google "G" — the recognizable, consumer-grade mark.
const GOOGLE_G = `
<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

const ICON_GUEST = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
const ICON_RESTORE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

/** True when the welcome screen should be shown (not signed in, not dismissed). */
export function shouldShowWelcome() {
  try {
    if (sync.status().isAuthenticated) return false;
    return localStorage.getItem(ONBOARD_KEY) !== '1';
  } catch {
    return false;
  }
}

function markOnboarded() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* private mode */ }
}

// Build a layer of randomised raindrops. Cheap (transform-only animation).
function rainLayer(count, cls) {
  const layer = el('div', { class: `wlc-rain ${cls}`, 'aria-hidden': 'true' });
  let html = '';
  for (let i = 0; i < count; i++) {
    const left = (Math.random() * 100).toFixed(2);
    const dur = (0.45 + Math.random() * 0.7).toFixed(2);
    const delay = (Math.random() * 7).toFixed(2);
    const h = Math.round(46 + Math.random() * 92);
    const op = (0.08 + Math.random() * 0.34).toFixed(2);
    html += `<span class="wlc-drop" style="left:${left}%;height:${h}px;opacity:${op};animation-duration:${dur}s;animation-delay:-${delay}s"></span>`;
  }
  layer.innerHTML = html;
  return layer;
}

/** Mount the welcome overlay. Calls `onDone()` once the user proceeds. */
export function showWelcome(onDone) {
  const finish = () => {
    overlay.classList.add('is-leaving');
    document.documentElement.classList.remove('wlc-open');
    setTimeout(() => { overlay.remove(); if (onDone) onDone(); }, 380);
  };

  const statusLine = el('div', { class: 'wlc-status' }, '');

  const signInBtn = el('button', { class: 'wlc-google', type: 'button' },
    el('span', { class: 'wlc-google-g', html: GOOGLE_G }),
    el('span', null, 'Sign in with Google'));

  const guestBtn = el('button', { class: 'wlc-ghost', type: 'button' },
    el('span', { class: 'wlc-ghost-ic', html: ICON_GUEST }), el('span', null, 'Continue as guest'));
  const restoreBtn = el('button', { class: 'wlc-ghost', type: 'button' },
    el('span', { class: 'wlc-ghost-ic', html: ICON_RESTORE }), el('span', null, 'Restore backup'));

  const setBusy = (busy) => {
    signInBtn.disabled = guestBtn.disabled = restoreBtn.disabled = busy;
    signInBtn.classList.toggle('is-busy', busy);
  };

  async function doSignIn() {
    if (signInBtn.disabled) return;
    setBusy(true);
    statusLine.className = 'wlc-status is-info';
    statusLine.textContent = 'Opening Google sign-in…';
    try {
      const st = await sync.signInWithGoogle();
      if (st && st.isAuthenticated) {
        statusLine.textContent = 'Signed in. Syncing your library…';
        try {
          if (sync.hasLocalData()) await sync.syncNow();
          else await sync.restoreFromCloud();
        } catch { /* sync is best-effort; proceed regardless */ }
        markOnboarded();
        finish();
      } else {
        statusLine.className = 'wlc-status is-error';
        statusLine.textContent = 'Sign-in failed. Please try again.';
        setBusy(false);
      }
    } catch (e) {
      statusLine.className = 'wlc-status is-error';
      statusLine.textContent = 'Sign-in failed: ' + ((e && e.message) || e);
      setBusy(false);
    }
  }

  // Restore from a JSON backup file (reuses the Settings import path).
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    setBusy(true);
    statusLine.className = 'wlc-status is-info';
    statusLine.textContent = 'Restoring backup…';
    try {
      await api.importBackup(await file.text());
      toast('Backup restored');
      markOnboarded();
      finish();
    } catch (e) {
      statusLine.className = 'wlc-status is-error';
      statusLine.textContent = 'Restore failed: ' + ((e && e.message) || e);
      setBusy(false);
    } finally {
      fileInput.value = '';
    }
  });

  signInBtn.addEventListener('click', doSignIn);
  guestBtn.addEventListener('click', () => { markOnboarded(); finish(); });
  restoreBtn.addEventListener('click', () => { if (!restoreBtn.disabled) fileInput.click(); });

  const logo = el('img', { class: 'wlc-logo', src: '/icon.png', alt: '' });
  logo.addEventListener('error', () => { logo.style.display = 'none'; });

  // ── Left: editorial hero ────────────────────────────────────────────────
  const hero = el('div', { class: 'wlc-hero' },
    el('div', { class: 'wlc-brand' },
      logo,
      el('span', { class: 'wlc-wordmark' }, 'NYORA')),
    el('div', { class: 'wlc-eyebrow' },
      el('span', { class: 'wlc-eyebrow-jp' }, '破壊'),
      'Manga, anywhere the night takes you'),
    el('h1', { class: 'wlc-title' },
      'Read like the ',
      el('em', null, 'world'),
      ' can wait.'),
    el('p', { class: 'wlc-sub' },
      'Nyora pulls hundreds of sources into one quiet shelf and remembers exactly where you stopped — on your phone, your tablet, your desk. Sign in to sync and back it up, or just start reading.'),
    el('ul', { class: 'wlc-features' },
      el('li', null, 'Hundreds of sources'),
      el('li', null, 'Picks up on every device'),
      el('li', null, 'No ads, ever')),
  );

  // ── Right: auth panel ───────────────────────────────────────────────────
  const auth = el('div', { class: 'wlc-auth' },
    el('div', { class: 'wlc-auth-head' }, 'Start reading'),
    signInBtn,
    el('div', { class: 'wlc-or' }, el('span', null, 'or')),
    el('div', { class: 'wlc-secondary' }, guestBtn, restoreBtn),
    statusLine,
    el('p', { class: 'wlc-foot' }, 'No account needed — go in as a guest and sync whenever you like.'),
    fileInput,
  );

  const stage = el('div', { class: 'wlc-inner' }, hero, auth);

  // Phones get a much lighter scene — far fewer raindrops, and (via CSS) no
  // backdrop blur / lightning — so the welcome doesn't lag low-power GPUs.
  const small = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;

  const overlay = el('div', { class: 'wlc', role: 'dialog', 'aria-label': 'Welcome to Nyora', 'aria-modal': 'true' },
    el('div', { class: 'wlc-sky', 'aria-hidden': 'true' },
      el('span', { class: 'wlc-glow wlc-glow-1' }),
      el('span', { class: 'wlc-glow wlc-glow-2' }),
      el('span', { class: 'wlc-mist' }),
      rainLayer(small ? 0 : 34, 'is-back'),
      rainLayer(small ? 22 : 54, 'is-front'),
      el('span', { class: 'wlc-flash' }),
      el('span', { class: 'wlc-horizon' }),
      el('span', { class: 'wlc-vignette' }),
    ),
    stage,
  );

  document.documentElement.classList.add('wlc-open');
  document.body.appendChild(overlay);

  // Awwwards-style staggered entrance for the welcome content (GSAP is loaded
  // globally; no-op when absent or under reduced-motion, so content never hides).
  try {
    const gsap = window.gsap;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (gsap && !reduce) {
      const items = overlay.querySelectorAll(
        '.wlc-brand, .wlc-eyebrow, .wlc-title, .wlc-sub, .wlc-features, .wlc-auth',
      );
      gsap.fromTo(items,
        { y: 26, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.7, stagger: 0.09, ease: 'power3.out', delay: 0.12 });
    }
  } catch { /* motion is optional polish */ }
}

export default { shouldShowWelcome, showWelcome };
