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
         if (status) {
           status.textContent = 'Скопировано';
           status.classList.remove('hidden');
           window.setTimeout(() => status.classList.add('hidden'), 1800);
         }
      } catch {
         if (status) {
           status.textContent = 'Не удалось скопировать';
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
    if (message) message.textContent = text;
  }

  async function poll(id, generation, targetMessage = message) {
    try {
      const response = await fetch(`/api/background-jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'Сессия истекла. Войдите в админ-панель.' : 'Не удалось получить состояние задачи. Обновите страницу.');
      const job = await response.json();
      if (generation !== polling && targetMessage === message) return;
      const suffix = job.error || job.runner?.error || '';
      const text = `${labels[job.state] || job.state}: ${job.completed} из ${job.total}. ${suffix}`;
      if (targetMessage) targetMessage.textContent = text;
      if (['queued', 'running'].includes(job.state)) {
        const next = () => poll(id, generation, targetMessage);
        if (targetMessage === message) timer = setTimeout(next, 1500);
        else window.setTimeout(next, 1500);
      } else if (targetMessage === message) {
        show(`${text} Обновите результаты.`);
      }
    } catch (error) {
      if (!controller.signal.aborted && targetMessage) targetMessage.textContent = error.message;
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
       show('Отправка запроса…');
      try {
        const response = await fetch(form.action, { method: 'POST', headers: { 'x-csrf-token': token },
          body: new URLSearchParams(new FormData(form)), signal: controller.signal });
         const data = await response.json();
         if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие. Повторите попытку.');
         if (form.hasAttribute('data-node-setting')) { window.location.reload(); return; }
         if (form.hasAttribute('data-node-check')) {
           const result = data.result || {};
           const status = form.closest('li')?.querySelector('[data-node-status]');
           const checked = form.closest('li')?.querySelector('[data-node-checked]');
           if (status) {
             status.textContent = result.status === 'healthy' ? 'Работает' : (result.errorMessage || result.status || 'Проверка завершена');
             status.className = `font-medium ${result.status === 'healthy' ? 'text-green-800' : 'text-gray-700'}`;
           }
           if (checked) checked.textContent = 'Проверено: только что';
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
