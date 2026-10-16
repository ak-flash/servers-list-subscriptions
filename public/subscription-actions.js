(() => {
  const region = document.querySelector('[data-job-region]');
  const message = region?.querySelector('[data-job-message]');
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  const labels = { queued: 'В очереди', running: 'Выполняется', completed: 'Завершена', failed: 'Завершена с ошибкой', interrupted: 'Прервана' };

  for (const button of document.querySelectorAll('[data-copy-connection]')) {
    button.addEventListener('click', async () => {
      const status = button.parentElement.querySelector('[data-copy-status]');
      try {
        await navigator.clipboard.writeText(decodeURIComponent(button.dataset.copyConnection));
        if (status) status.textContent = 'Скопировано';
      } catch {
        if (status) status.textContent = 'Не удалось скопировать. Разрешите доступ к буферу обмена.';
      }
    });
  }
  let polling = 0;
  let timer;
  const controller = new AbortController();

  function show(text) {
    if (message) message.textContent = text;
  }

  async function poll(id, generation) {
    try {
      const response = await fetch(`/api/background-jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'Сессия истекла. Войдите в админ-панель.' : 'Не удалось получить состояние задачи. Обновите страницу.');
      const job = await response.json();
      if (generation !== polling) return;
      const suffix = job.error || job.runner?.error || '';
      show(`${labels[job.state] || job.state}: ${job.completed} из ${job.total}. ${suffix}`);
      if (['queued', 'running'].includes(job.state)) timer = setTimeout(() => poll(id, generation), 1500);
      else show(`${labels[job.state] || job.state}: ${job.completed} из ${job.total}. ${suffix} Обновите результаты.`);
    } catch (error) {
      if (!controller.signal.aborted) show(error.message);
    }
  }

  for (const form of document.querySelectorAll('[data-background-action], [data-node-setting]')) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      form.setAttribute('aria-busy', 'true');
      show('Отправка запроса…');
      try {
        const response = await fetch(form.action, { method: 'POST', headers: { 'x-csrf-token': token },
          body: new URLSearchParams(new FormData(form)), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие. Повторите попытку.');
        if (form.hasAttribute('data-node-setting')) { window.location.reload(); return; }
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
      }
    });
  }
  if (region?.dataset.jobId) poll(region.dataset.jobId, ++polling);
  window.addEventListener('pagehide', () => { clearTimeout(timer); controller.abort(); }, { once: true });
})();
