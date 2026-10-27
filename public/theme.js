(() => {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const buttons = Array.from(document.querySelectorAll('[data-theme-toggle]'));

  const storedTheme = () => {
    try {
      return localStorage.getItem('theme');
    } catch (error) {
      return null;
    }
  };

  const apply = dark => {
    root.classList.toggle('dark', dark);
    buttons.forEach(button => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? (window.appTranslations?.lightTheme || 'Enable light theme') : (window.appTranslations?.darkTheme || 'Enable dark theme'));
    });
  };

  const currentIsDark = () => {
    const stored = storedTheme();
    return stored ? stored === 'dark' : media.matches;
  };

  apply(root.classList.contains('dark'));

  buttons.forEach(button => {
    button.addEventListener('click', () => {
      const next = !root.classList.contains('dark');
      apply(next);
      try {
        localStorage.setItem('theme', next ? 'dark' : 'light');
      } catch (error) {
        // Storage may be unavailable; the theme still applies for this page.
      }
    });
  });

  media.addEventListener('change', event => {
    if (!storedTheme()) apply(event.matches);
  });
})();
