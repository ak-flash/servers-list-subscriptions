document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('[data-nav-toggle]');
  const menu = document.querySelector('[data-nav-menu]');
  if (!toggle || !menu) return;

  const openIcon = toggle.querySelector('[data-nav-icon-open]');
  const closeIcon = toggle.querySelector('[data-nav-icon-close]');
  const desktop = window.matchMedia('(min-width: 768px)');

  const setOpen = open => {
    menu.classList.toggle('hidden', !open && !desktop.matches);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    openIcon?.classList.toggle('hidden', open);
    closeIcon?.classList.toggle('hidden', !open);
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('click', event => {
    if (toggle.getAttribute('aria-expanded') === 'true' && !menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setOpen(false);
  });
  desktop.addEventListener('change', () => {
    menu.classList.toggle('hidden', !desktop.matches);
    if (desktop.matches) setOpen(false);
  });
  setOpen(false);
});
