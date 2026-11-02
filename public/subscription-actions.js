(() => {
  const region = document.querySelector('[data-job-region]');
  const message = region?.querySelector('[data-job-message]');
  const details = region?.querySelector('[data-job-details]');
  const progress = region?.querySelector('[data-job-progress]');
  const queueProgress = region?.querySelector('[data-queue-progress]');
  const queueLabel = region?.querySelector('[data-queue-progress-label]');
  const queuePercent = region?.querySelector('[data-queue-percent]');
  const queueCount = region?.querySelector('[data-queue-count]');
  const queueRunning = region?.querySelector('[data-queue-running]');
  const queueWait = region?.querySelector('[data-queue-wait]');
  const queueError = region?.querySelector('[data-queue-error]');
  const queueWarning = region?.querySelector('[data-queue-warning]');
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
  let queueTimer;
  let queueFetching = false;
  let queueSessionExpired = false;
  let controller = new AbortController();

  function show(text) {
    details?.classList.remove('hidden');
    if (message) message.textContent = text;
  }

  function renderQueue(metrics) {
    const total = Math.max(0, Number(metrics.progress?.total) || 0);
    const completed = Math.max(0, Math.min(Number(metrics.progress?.completed) || 0, total));
    const percent = total ? Math.floor(completed / total * 100) : 0;
    queueProgress.max = total || 1;
    queueProgress.value = completed;
    queueProgress.textContent = `${percent}%`;
    queuePercent.textContent = `${percent}%`;
    queueLabel.textContent = total ? (translations.queueProgress || 'Tasks processed: {completed} of {total}')
      .replace('{completed}', completed).replace('{total}', total) : (translations.queueEmpty || 'Queue is empty');
    queueCount.textContent = metrics.queued;
    queueRunning.textContent = metrics.running.check;
    queueWait.textContent = Math.ceil(metrics.oldest_wait_ms / 60000);
    const warning = metrics.storage_error || metrics.runner?.error;
    if (queueWarning) {
      queueWarning.classList.toggle('hidden', !warning);
      queueWarning.textContent = warning ? `${warning} ${translations.healthValid || 'The last successful VPN test remains valid until it expires.'}` : '';
    }
  }

  async function pollQueue() {
    if (!queueProgress || queueFetching || queueSessionExpired || controller.signal.aborted) return;
    clearTimeout(queueTimer);
    if (document.hidden) return;
    queueFetching = true;
    const requestController = controller;
    let retryDelay = 1500;
    try {
      const signal = AbortSignal.any([requestController.signal, AbortSignal.timeout(10000)]);
      const response = await fetch('/api/background-queue', { signal, cache: 'no-store' });
      if (requestController.signal.aborted) return;
      if (response.status === 401) queueSessionExpired = true;
      if (!response.ok) throw new Error('Queue request failed');
      const metrics = await response.json();
      if (requestController.signal.aborted) return;
      renderQueue(metrics);
      queueError?.classList.add('hidden');
    } catch {
      if (!requestController.signal.aborted && queueError) {
        queueError.textContent = queueSessionExpired ? (translations.sessionExpired || 'Session expired. Sign in to the admin panel.') :
          (translations.queueFailed || 'Could not refresh the queue. The displayed data may be outdated.');
        queueError.classList.remove('hidden');
      }
      retryDelay = 5000;
    } finally {
      if (requestController === controller) {
        queueFetching = false;
        if (!requestController.signal.aborted && !queueSessionExpired && !document.hidden) queueTimer = setTimeout(pollQueue, retryDelay);
      }
    }
  }

  function updateProgress(job) {
    if (!progress) return;
    const total = Number(job.total) || 0;
    progress.classList.toggle('hidden', total <= 0);
    progress.max = Math.max(total, 1);
    progress.value = Math.max(0, Math.min(Number(job.completed) || 0, total));
  }

  async function poll(id, generation, targetMessage = message) {
    const requestController = controller;
    try {
      const response = await fetch(`/api/background-jobs/${encodeURIComponent(id)}`, { signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 401 ? (translations.sessionExpired || 'Session expired. Sign in to the admin panel.') : (translations.jobFailed || 'Could not get the job status. Refresh the page.'));
      const job = await response.json();
      if (requestController.signal.aborted || (generation !== polling && targetMessage === message)) return;
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
      if (!requestController.signal.aborted) {
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
         if (region) region.dataset.jobId = data.jobId;
          poll(data.jobId, ++polling);
          pollQueue();
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
  if (queueProgress) {
    pollQueue();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(queueTimer);
      else pollQueue();
    });
  }
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(queueTimer); controller.abort(); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    controller = new AbortController();
    queueFetching = false;
    queueSessionExpired = false;
    if (region?.dataset.jobId) poll(region.dataset.jobId, ++polling);
    pollQueue();
  });
})();
