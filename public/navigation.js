document.addEventListener('DOMContentLoaded', () => {
  const root = document.querySelector('[data-nav-root]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const menu = document.querySelector('[data-nav-menu]');
  if (!root || !toggle || !menu) return;

  const openIcon = toggle.querySelector('[data-nav-icon-open]');
  const closeIcon = toggle.querySelector('[data-nav-icon-close]');
  const desktop = window.matchMedia('(min-width: 768px)');

  const setOpen = open => {
    const shouldShow = open || desktop.matches;
    menu.classList.toggle('hidden', !shouldShow);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? (window.appTranslations?.closeMenu || 'Close menu') : (window.appTranslations?.openMenu || 'Open menu'));
    openIcon?.classList.toggle('hidden', open);
    closeIcon?.classList.toggle('hidden', !open);
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('click', event => {
    if (!desktop.matches && !root.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setOpen(false);
  });
  desktop.addEventListener('change', () => setOpen(false));
  setOpen(false);
});
