import { initBackgroundVideo } from './background-video';

/**
 * Presentation-only behaviour for the landing page: a header that gains a
 * background once you scroll off the hero, and content that fades up as it
 * comes into view. Nothing here touches the upscaler.
 */

const REVEAL_SELECTOR = [
  '.logo-strip',
  '.section-head',
  '.cards > .card',
  '.banner',
  '.steps li',
  '.stats > .stat',
  '.faq details',
  '.cta-bar',
].join(', ');

export function initLandingUi() {
  themeToggle();
  navMenu();
  stickyHeader();
  revealOnScroll();
  initBackgroundVideo();
}

/**
 * The narrow-screen nav is a <details>, so it opens and closes without any of
 * this. What JS adds is the dismissal a menu is expected to have: picking a
 * link, clicking away, or pressing Escape all close it.
 */
function navMenu() {
  const menu = document.querySelector<HTMLDetailsElement>('#navmenu');
  if (!menu) return;

  const close = () => {
    menu.open = false;
  };

  for (const link of menu.querySelectorAll('a')) {
    link.addEventListener('click', close);
  }

  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target as Node)) close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    close();
    menu.querySelector('summary')?.focus();
  });
}

const THEME_KEY = 'seeb4-theme';
type Theme = 'light' | 'dark';

const systemTheme = (): Theme =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

/**
 * Three states: no attribute means follow the OS, and an explicit
 * data-theme pins it. The stylesheet resolves all of this through
 * light-dark(), so flipping the attribute is the whole switch.
 *
 * An inline script in index.html applies the stored value before first paint,
 * which is what stops the wrong palette flashing while this module loads.
 */
function themeToggle() {
  const button = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (!button) return;

  const stored = readStored();
  const label = () => {
    const current = document.documentElement.dataset.theme as Theme | undefined;
    const effective = current ?? systemTheme();
    button.title = effective === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', button.title);
  };

  if (stored) document.documentElement.dataset.theme = stored;
  label();

  button.addEventListener('click', () => {
    const current = (document.documentElement.dataset.theme as Theme | undefined) ?? systemTheme();
    const next: Theme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode and blocked storage are fine — the choice just won't persist.
    }
    label();
  });

  // Follow the OS while the user hasn't expressed a preference of their own.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!readStored()) label();
  });
}

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function stickyHeader() {
  const header = document.querySelector<HTMLElement>('.topbar');
  if (!header) return;

  // A zero-height sentinel at the top of the document: once it scrolls out of
  // view the header is detached, which is cheaper than listening to scroll.
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
  document.body.prepend(sentinel);

  new IntersectionObserver(
    ([entry]) => header.classList.toggle('is-stuck', !entry?.isIntersecting),
    { threshold: 0 },
  ).observe(sentinel);
}

function revealOnScroll() {
  const targets = [...document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR)];
  if (!targets.length) return;

  if (!('IntersectionObserver' in window) || prefersReducedMotion()) {
    for (const element of targets) element.classList.add('is-in');
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const element = entry.target as HTMLElement;
        // Stagger siblings so a row arrives as a sweep rather than all at once.
        const index = Number(element.dataset.revealIndex ?? 0);
        element.style.transitionDelay = `${Math.min(index, 5) * 60}ms`;
        element.classList.add('is-in');
        observer.unobserve(element);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  );

  for (const element of targets) {
    element.dataset.reveal = '';
    const siblings = element.parentElement ? [...element.parentElement.children] : [];
    element.dataset.revealIndex = String(Math.max(0, siblings.indexOf(element)));
    observer.observe(element);
  }
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
