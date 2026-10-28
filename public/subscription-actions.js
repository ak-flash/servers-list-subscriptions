(() => {
  const region = document.querySelector('[data-job-region]');
  const message = region?.querySelector('[data-job-message]');
  const details = region?.querySelector('[data-job-details]');
  const progress = region?.querySelector('[data-job-progress]');
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  const translations = window.appTranslations || {};
  const labels = { queued: translations.queued || 'Queued', running: translations.running || 'In progress', completed: translations.completed || 'Completed', failed: translations.failed || 'Completed with errors', interrupted: translations.interrupted || 'Interrupted' };

  for (const button of document.querySelectorAll('[data-copy-connection]')) {
    button.addEventListener('click', async () => {
      const status = button.parentElement.querySelector('[data-copy-status]');
      try {
        await navigator.clipboard.writeText(decodeURIComponent(button.dataset.copyConnection));
         if (status) {
           status.textContent = translations.copied || 'Copied';
           status.classList.remove('hidden');
           window.setTimeout(() => status.classList.add('hidden'), 1800);
         }
      } catch {
         if (status) {
           status.textContent = translations.copyFailed || 'Could not copy';
           status.classList.remove('hidden');
           window.setTimeout(() => status.classList.add('hidden'), 3000);
         }
      }
    });
  }
  let polling = 0;
  let timer;
  const controller = new AbortController();

  function show(text) {
    details?.classList.remove('hidden');
    if (message) message.textContent = text;
  }

  function updateProgress(job) {
    if (!progress) return;
    const total = Number(job.total) || 0;
    progress.classList.toggle('hidden', total <= 0);
    progress.max = Math.max(total, 1);
    progress.value = Math.max(0, Math.min(Number(job.completed) || 0, total));
  }

  async function poll(id, generation, targetMessage = message) {
    try {
      const response = await fetch(`/api/background-jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? (translations.sessionExpired || 'Session expired. Sign in to the admin panel.') : (translations.jobFailed || 'Could not get the job status. Refresh the page.'));
      const job = await response.json();
      if (generation !== polling && targetMessage === message) return;
      const suffix = job.error || job.runner?.error || '';
      const text = `${labels[job.state] || job.state}: ${job.completed} ${translations.of || 'of'} ${job.total}. ${suffix}`;
      if (targetMessage === message) {
        show(text);
        updateProgress(job);
      } else if (targetMessage) targetMessage.textContent = text;
      if (['queued', 'running'].includes(job.state)) {
        const next = () => poll(id, generation, targetMessage);
        if (targetMessage === message) timer = setTimeout(next, 1500);
        else window.setTimeout(next, 1500);
      } else if (targetMessage === message) {
        show(`${text} ${translations.refresh || 'Refresh results.'}`);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (targetMessage === message) show(error.message);
        else if (targetMessage) targetMessage.textContent = error.message;
      }
    }
  }

  for (const form of document.querySelectorAll('[data-background-action], [data-node-setting]')) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
       button.disabled = true;
       form.setAttribute('aria-busy', 'true');
       if (form.hasAttribute('data-node-check')) {
         form.querySelector('[data-check-label]')?.classList.add('invisible');
         form.querySelector('[data-check-spinner]')?.classList.remove('hidden');
         form.querySelector('[data-check-spinner]')?.classList.add('flex');
       }
       progress?.classList.add('hidden');
       show(translations.sending || 'Sending request…');
      try {
        const response = await fetch(form.action, { method: 'POST', headers: { 'x-csrf-token': token },
          body: new URLSearchParams(new FormData(form)), signal: controller.signal });
         const data = await response.json();
         if (!response.ok) throw new Error(data.error || translations.actionFailed || 'Could not complete the action. Try again.');
         if (form.hasAttribute('data-node-setting')) { window.location.reload(); return; }
         if (form.hasAttribute('data-node-check')) {
           const result = data.result || {};
           const status = form.closest('li')?.querySelector('[data-node-status]');
           const checked = form.closest('li')?.querySelector('[data-node-checked]');
           if (status) {
             status.textContent = result.status === 'healthy' ? (translations.working || 'Working') : (result.errorMessage || result.status || translations.checkCompleted || 'Check completed');
             status.className = `font-medium ${result.status === 'healthy' ? 'text-green-800' : 'text-gray-700'}`;
           }
           if (checked) checked.textContent = translations.checkedJustNow || 'Checked: just now';
           return;
         }
         clearTimeout(timer);
         const url = new URL(window.location.href);
         url.searchParams.set('job', data.jobId);
         window.history.replaceState(null, '', url);
         poll(data.jobId, ++polling);
      } catch (error) {
        if (!controller.signal.aborted) show(error.message);
      } finally {
       button.disabled = false;
       form.removeAttribute('aria-busy');
       if (form.hasAttribute('data-node-check')) {
         form.querySelector('[data-check-label]')?.classList.remove('invisible');
         form.querySelector('[data-check-spinner]')?.classList.add('hidden');
         form.querySelector('[data-check-spinner]')?.classList.remove('flex');
       }
      }
    });
  }
  if (region?.dataset.jobId) poll(region.dataset.jobId, ++polling);
  window.addEventListener('pagehide', () => { clearTimeout(timer); controller.abort(); }, { once: true });
})();
