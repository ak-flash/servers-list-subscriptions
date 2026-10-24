(() => {
  const toastContainer = () => {
    let el = document.getElementById('ui-toast-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ui-toast-container';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    return el;
  };

  window.uiToast = (message, type = 'info', timeoutMs = 4000) => {
    const container = toastContainer();
    const el = document.createElement('div');
    el.className = `ui-toast ui-toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    const remove = () => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 200);
    };
    if (timeoutMs > 0) setTimeout(remove, timeoutMs);
    el.addEventListener('click', remove);
    return remove;
  };

  window.uiConfirm = ({ title = 'Подтвердите действие', message = '', confirmText = 'Подтвердить', cancelText = 'Отмена', danger = false } = {}) =>
    new Promise(resolve => {
      const backdrop = document.createElement('div');
      backdrop.id = 'ui-confirm-backdrop';
      backdrop.innerHTML = `
        <div id="ui-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ui-confirm-title" aria-describedby="ui-confirm-message">
          <p id="ui-confirm-title"></p>
          <p id="ui-confirm-message"></p>
          <div id="ui-confirm-actions">
            <button type="button" data-confirm-cancel class="rounded-lg border border-slate-300 px-4 py-2 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"></button>
            <button type="button" data-confirm-ok class="rounded-lg px-4 py-2 font-semibold text-white"></button>
          </div>
        </div>`;
      backdrop.querySelector('#ui-confirm-title').textContent = title;
      backdrop.querySelector('#ui-confirm-message').textContent = message;
      const cancelBtn = backdrop.querySelector('[data-confirm-cancel]');
      const okBtn = backdrop.querySelector('[data-confirm-ok]');
      cancelBtn.textContent = cancelText;
      okBtn.textContent = confirmText;
      okBtn.className = `rounded-lg px-4 py-2 font-semibold text-white ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`;
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('is-visible'));
      const close = result => {
        backdrop.classList.remove('is-visible');
        setTimeout(() => backdrop.remove(), 180);
        document.removeEventListener('keydown', onKey);
        resolve(result);
      };
      const onKey = event => {
        if (event.key === 'Escape') close(false);
      };
      cancelBtn.addEventListener('click', () => close(false));
      okBtn.addEventListener('click', () => close(true));
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) close(false);
      });
      document.addEventListener('keydown', onKey);
      okBtn.focus();
    });

  window.uiSetBusy = (button, busy, label) => {
    if (!button) return;
    if (busy) {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      const text = label ? `<span class="btn-spinner" aria-hidden="true"></span>${label}` : '<span class="btn-spinner" aria-hidden="true"></span>';
      button.innerHTML = text;
    } else {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }
  };

  const ensureProgress = () => {
    let wrap = document.getElementById('ui-progress');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'ui-progress';
      wrap.innerHTML = '<div id="ui-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>';
      document.body.appendChild(wrap);
    }
    return wrap.querySelector('#ui-progress-bar');
  };

  window.uiProgress = {
    set(pct) {
      const bar = ensureProgress();
      bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      if (pct >= 100) setTimeout(() => { bar.style.width = '0%'; }, 400);
    },
    done() {
      this.set(100);
    },
  };

  const icons = {
    add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v5h8V4M8 20v-6h8v6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7l1-3h6l1 3"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-9 9M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  };

  const initUi = () => {
    document.querySelectorAll('[data-icon]').forEach(element => {
      if (element.dataset.iconApplied === 'true') return;
      const icon = icons[element.dataset.icon];
      if (!icon) return;
      element.insertAdjacentHTML('afterbegin', icon);
      element.classList.add('ui-icon-button');
      element.dataset.iconApplied = 'true';
    });

    const path = window.location.pathname;
    document.querySelectorAll('nav a.nav-link, nav[aria-label] a').forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;
      const isRoot = href === '/admin';
      const active = isRoot ? path === '/admin' : path.startsWith(href);
      link.classList.add('nav-link');
      if (active) link.setAttribute('data-active', 'true');
    });

    document.querySelectorAll('form[data-confirm]').forEach(form => {
      if (form.dataset.confirmBound === 'true') return;
      form.dataset.confirmBound = 'true';
      form.addEventListener('submit', async event => {
        if (form.dataset.confirmed === 'true') return;
        event.preventDefault();
        const ok = await window.uiConfirm({
          title: form.dataset.confirmTitle || 'Подтвердите действие',
          message: form.dataset.confirm || 'Вы уверены?',
          confirmText: form.dataset.confirmOk || 'Подтвердить',
          danger: form.dataset.confirmDanger === 'true',
        });
        if (ok) {
          form.dataset.confirmed = 'true';
          form.submit();
        }
      });
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUi, { once: true });
  } else {
    initUi();
  }
})();
