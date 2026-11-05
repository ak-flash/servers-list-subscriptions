# План: проверка и отбор узлов подписок

Рабочий документ по итогам ревизии цепочки:

`импорт источника → subscription_nodes → health/eligibility → ranking → resolveUserSubscription → /join`

- База: `main`, коммит `5e3f9d4` («Rework probe policy, ranking and lossless source links»). Ссылки на строки кода относятся к этой базе.
- Тесты при создании плана и повторном ревью: **123/123 pass** (`npm test`). Реальный Xray suite (`npm run test:vpn`) при ревью не запускался.
- Документ описывает предстоящие работы, а не выполненные исправления. Номера #1–#13 сохранены; #14–#16 добавлены по результатам ревью.
- Подтверждённые дефекты отделены от изменений политики. Adaptive TTL / stale fallback, сохранение каталога после смены аккаунта, dedupe и смысл latency-фильтра не менять без отдельного решения.

## Инварианты

- Выдача и preview строятся только из БД: без DNS, загрузки источников или запуска Xray в `/join` и resolver.
- Исходный URI не пересобирается: меняется только имя (фрагмент / VMess `ps`). Проверенный IP не подставляется в ссылку клиента; параметры не удаляются ради успешного probe.
- По умолчанию выдаются только результаты текущего профиля, fingerprint и generation с достаточным числом успехов, корректным адресом и временем проверки. Отключённые, отсутствующие и неподдерживаемые узлы не выдаются.
- `runner_error` / cancellation сохраняют last-good, но **не обновляют** его timestamp или срок действия. Завершённый отрицательный verdict исключает узел; прежний `last_success_at` его не восстанавливает.
- Переименование не инвалидирует health. Возвращение исчезнувшего узла и реальное изменение конфигурации требуют новой проверки; поздние результаты старого поколения / source revision / цикла не применяются.
- IP-only dedupe остаётся действующей политикой до решения по #9. Дедупликация относится к фактически выбранным внешним узлам между источниками; ручные назначения не ограничиваются этим фильтром.
- Все управляемые источником адреса подключения должны проходить public validation и numeric pinning до запуска Xray. Mixed DNS с private-адресом по умолчанию отклоняется; изменение этой политики не входит автоматически в #6.
- HTTP validators относятся к конкретному представлению источника. Полнота парсинга, принятие снимка и свежесть VPN-проверки — разные состояния; 304 не обновляет health.
- Импорт, reparse и очистка истории сохраняют идентичность и ручные исключения узлов в пределах отдельно установленного срока хранения отсутствующих записей.

---

## Сводка приоритетов и зависимостей

| # | Приоритет | Задача | Основные файлы | Зависимости / решение |
|---|-----------|--------|----------------|----------------------|
| 1 | P0 | Смена имени сбрасывает health; безопасное восстановление узла | `subscriptionSources.js` | Семантическая идентичность и generation |
| 2 | P0 | Unsupported делает снимок частичным; unsupported-only принимается как opaque | `subscriptionParser.js`, `subscriptionSources.js` | Контракт полноты и принятия снимка |
| 3 | P0 | Настройки history игнорируются | `subscriptionHealth.js`, `probeScheduler.js` | Не менять retention отсутствующих узлов |
| 4 | P0 | Бюджет deadline и совместимость настроек | `proxySettings.js`, `config/subscriptions.js`, `vpnChecker.js` | Общий дизайн с #6; миграция до строгой валидации |
| 5 | P1 | Пропускная способность, TTL и наблюдаемость | `probeScheduler.js`, `subscriptionHealth.js`, `subscriptionResolver.js` | Сначала #12, #15, #16 и бюджеты #4/#6; TTL — решение политики |
| 6 | P1 | Multi-address probe без смены SSRF-политики | `safeHttp.js`, `vpnChecker.js`, `xrayConfigBuilder.js` | #4, #14; provenance direct/proxy |
| 7 | P1 | Подтверждение подозрительного сокращения снимка | `subscriptionSources.js`, миграции БД | #2; persisted state, 304 и лимит каталога |
| 8 | P1 | Политика смены URL / Authorization / User-Agent | `subscriptionSources.js`, `subscriptionHealth.js`, UI | Отдельное решение; согласовать с #7 |
| 9 | P2 | Семантика IP-only / IP:port / config dedupe | `subscriptionHealth.js`, `subscriptionResolver.js` | Только после согласования |
| 10 | P2 | Смысл пользовательского порога задержки | `subscriptionResolver.js`, `subscriptionHealth.js`, UI | Только после согласования |
| 11 | P2 | Кандидат в каталоге и точные причины отбора в preview | `subscriptionResolver.js`, `subscriptionHealth.js`, views | Использовать действующий resolver |
| 12 | P1 | Общая очередь, concurrency и dedupe ручных проверок | `probeScheduler.js`, routes, `subscription-actions.js` | Совместно с #15; сохранить или обновить HTTP/UI-контракт |
| 13 | P1 / P2 | Redaction и cleanup CONNECT; документация и счётчики | `vpnChecker.js`, views, docs | Security/cleanup не откладывать как «мелочи» |
| 14 | P1 | Пропуск SSRF-валидации дополнительных XHTTP endpoints | `protocolParsers.js`, `xrayConfigBuilder.js`, `vpnChecker.js` | Security-blocker перед расширением DNS/probe |
| 15 | P1 | Источник больше capacity вообще не попадает в очередь | `probeScheduler.js`, UI метрик | Порционная постановка до изменения TTL и массовой перепроверки |
| 16 | P1 | Восстановление бинарника не восстанавливает available | `vpnChecker.js`, `probeScheduler.js` | Независимое исправление кеша проверки Xray |

Оценки исходной версии требуют пересмотра после выбора контрактов: прежние 1–6 часов для #4, #6–#8 и #12 не учитывали миграции, гонки, HTTP/UI и интеграционные тесты. Оценивать реализацию, тесты и выкатку отдельно; альтернативы политики не считать уже выбранными.

---

# Задачи

## 1. Смена только имени узла сбрасывает health

**Симптом.** Провайдер меняет emoji/название → узел исчезает из `/join` до следующей завершённой проверки, хотя параметры подключения не менялись. Старый `next_check_at` может добавить ожидание интервала (по умолчанию 5 минут); под нагрузкой ожидание больше.

**Причина.** `src/services/subscriptionSources.js:158` сравнивает `raw_link`, включающий фрагмент / VMess `ps`. При изменении выполняются `generation++`, сброс health и `last_checked_at=NULL` (`:163-182`), но старый `next_check_at` для present-узла сохраняется (`:168`).

**Воспроизведение (подтверждено).** Импорт `vless://...#Name A` → healthy → импорт того же URI с `#Name B`: generation растёт, status становится unknown, выдача теряет узел.

**Реализация.**
- [x] Определить единый семантический критерий конфигурационного изменения для `applySnapshot` и `reparseStoredNodes`: canonical fingerprint, наличие конфигурации, capability/состояние парсинга. Не использовать неканонический `JSON.stringify` как критерий идентичности. Оба пути теперь используют fingerprint, наличие config и capability/error.
  - Fingerprint конфига уже канонизирует ключи (`src/utils/protocolParsers.js:14-23`). Перестановка ключей вложенных WS headers сохраняет fingerprint, но меняет JSON-строку — это не изменение подключения.
  - При реальном изменении fingerprint возможна новая запись; не переносить health между разными конфигурациями. Reparse существующей записи должен инвалидировать её поколение при реальном изменении.
- [x] Отдельная metadata-only ветка допустима только при **`old.is_present && sameConfig`**: В `applySnapshot` сохранены generation/health/pending/next_check для present-узла.
  - обновить исходный `raw_link`, отображаемое `name`, `last_seen_at` и согласованные метаданные;
  - сохранить generation, весь health, `pending_cycle_id` и `next_check_at`.
- [x] При возвращении отсутствовавшего узла, reset или конфигурационном изменении увеличить generation, очистить pending cycle и недействительные direct/proxy-результаты, поставить `next_check_at=0`. Сам факт совпадения fingerprint не разрешает восстановить старый verdict. Реализовано для snapshot path; reparse/health transfer требует отдельного теста.
- [x] В `reparseStoredNodes` обновлять только имя/метаданные отдельным путём, не направляя его в существующую ветку удаления health. Сохранить правила слияния записей, идентичность и ручные исключения. Простая metadata-only reparse больше не инвалидирует health.

**Тесты.**
- [x] VLESS fragment and VMess `ps` metadata-only rename regressions preserve semantic config fingerprint; WS-header canonicalization and late-result guards are covered by existing source/health tests.
- [x] Исправление только сохранённого `name` через reparse/startup/304 не инвалидирует health.
- [x] Изменение capability/состояния парсинга или конфигурации требует новой проверки и делает узел due.
- [x] Исчезновение → возвращение с тем же fingerprint не выдаёт узел до новой проверки; сохранить `test/sources.test.js:25-30`.
- [x] Поздний `recordResult` проверки, начатой до исчезновения/возвращения или reset, отклоняется.

**Критерий готовности.** Метаданные не влияют на выдачу, но возвращение и изменение конфигурации не переиспользуют старую проверку.

---

## 2. Неподдерживаемая ссылка делает снимок «частичным» навсегда

**Симптом.** В смешанном источнике с неподдерживаемыми протоколами исчезнувшие узлы остаются present, продолжают проверяться и могут выдаваться. `sync_status=partial`, validators сбрасываются, каждый sync загружает полный ответ.

**Причина.** `src/utils/subscriptionParser.js:74` связывает полноту с наличием `node.config`. Кроме того, при `parsedNodes === 0` парсер бросает `unsupported_format` **до вычисления `complete`** (`:63-74`). Поэтому одной замены формулы недостаточно для перехода `VLESS + SS → только SS`.

**Воспроизведение (подтверждено).**
- `VLESS A + VLESS B + SS → VLESS A + SS`: B остаётся present.
- Полностью SS-снимок, в том числе Base64, отклоняется как `unsupported_format`.
- Повреждённый `ss://` без содержимого сейчас классифицируется как unsupported; префикс схемы сам по себе не подтверждает корректность записи.

**Контракт и реализация.**
- [x] Разделить три класса записей: поддерживаемая конфигурация; структурно допустимая неподдерживаемая запись (opaque); повреждённая/нераспознанная запись. Opaque не становится supported и не участвует в VPN-выдаче.
- [x] Задать консервативные правила структурной проверки opaque-форматов: непустой payload, ограничение длины и запрет управляющих символов; произвольный текст без `scheme://payload` остаётся invalid.
- [x] Отделить распознавание документа подписки от числа supported/config-записей: допустимый полностью opaque-документ принимается. HTML, произвольный текст и пустой ответ остаются ошибкой с сохранением каталога.
- [x] Вычислять полноту по явным результатам разбора всех записей, не по `config !== null` и не по неявному `structural !== false`. `complete` теперь зависит от invalid-записей; opaque-only snapshots принимаются. Добавлен `report.unparseable` для invalid-записей.
- [x] Разделить `parseComplete` и решение импорта `accepted/suspect/partial`: parser/snapshot contract теперь явно возвращает `parseComplete` и `acceptance`; политика suspect confirmation остаётся отдельным importer state.
- [x] Если поддерживаются URI, разделённые пробелом, выполнять согласованную токенизацию после определения/декодирования формата, а не только до Base64. Разделение выполняется только перед известной схемой после декодирования; имена и percent-encoded пробелы сохраняются.
- [x] Сохранять ETag/Last-Modified только для принятого полного снимка. Неподдерживаемая, но структурно допустимая запись сама по себе не делает его partial.

**Тесты.**
- [x] Матрица plain/Base64/Base64URL × newline/разрешённые разделители × supported/opaque/mixed покрыта parser regression-тестами.
- [x] Source-level сценарий VLESS + opaque → только opaque добавлен; исчезнувший VLESS помечается absent, opaque-узел остаётся present.
- [x] All-opaque документ больше не блокируется отсутствием supported nodes; добавлены parser и source regression-тесты для unsupported-only URI и удаления последнего supported узла.
- [x] Parser regression для `invalid` сохранён; opaque URI принимаются только при наличии корректной `scheme://payload` структуры, управляющие символы и пустые payload отклоняются.
- [x] После принятого mixed/opaque snapshot 304 работает; partial/непринятый ответ не сертифицируется старыми validators. Добавлена проверка принятого representation перед 304.

**Критерий готовности.** Неподдерживаемость протокола не блокирует синхронизацию состава, но повреждённый документ не считается полным. Пустой каталог требует отдельного решения, а не побочного эффекта этой правки.

---

## 3. `PROBE_HISTORY_DAYS` и `PROBE_HISTORY_MAX_ROWS` игнорируются

**Причина.** `src/services/subscriptionHealth.js:148-156` использует 1 день и 10 000 строк вместо `historyDays` (default 7) / `maxHistoryRows` (50 000) из `src/config/subscriptions.js:97-98`. Отсутствующие узлы отдельно хранятся 30 дней.

**Реализация.**
- [x] Изменить сигнатуру на `pruneHistory(now, config)` и передавать captured config из `probeScheduler.tick()`.
- [x] Применять `config.historyDays` **только к `subscription_node_checks`**. Retention отсутствующих узлов оставить 30 дней; отдельный `removedRetentionDays` вводить только с согласованной семантикой.
  - Удаление absent-записи уничтожает её ID, health и `is_enabled=0`. При возвращении она создаётся заново включённой; сокращение retention — не просто очистка истории.
- [x] Использовать `config.maxHistoryRows` с точной границей: при сохранении текущего условия `id < threshold` требуется `OFFSET maxHistoryRows - 1`. `pruneHistory(now, config)` теперь получает лимиты из scheduler.
- [x] Сохранять одновременно возрастной и количественный предел истории direct/proxy. Свежие строки тоже могут удаляться при превышении row cap.
- [x] `pruneHistory()` выполняет hourly/periodic cleanup транзакционно; `maxHistoryRows` — предел после очистки. Возвращаются `before/after/deleted` для наблюдения фактического объёма; размер export/save проверяется отдельным operational benchmark.
- [x] History retention remains configuration-driven and is intentionally not exposed as an editable UI setting; the UI does not promise unsupported history controls.

**Тесты.**
- [x] `maxHistoryRows=100`: добавлен тест row cap; возрастная граница и отдельные direct/proxy границы требуют расширения теста.
- [x] Конфиг действительно проходит из `tick`; health существующих узлов не меняется.
- [x] Disabled absent-узел не удаляется вместе с короткой историей и возвращается до 30 дней с прежним ID/исключением.

**Критерий готовности.** После prune соблюдены оба заданных ограничения истории без неявного изменения retention узлов и их ручных исключений.

---

## 4. `deadlineMs`: бюджет проверки, валидация и совместимость

**Подтверждённое поведение.** `loadConfig` всегда задаёт deadline (default 40 с), поэтому fallback-расчёт в `applySettingsToConfig` почти недостижим (`src/services/proxySettings.js:114-117`). UI позволяет повысить таймауты, сохранив 40 с. Это закреплено текущими тестами; менять семантику нужно совместимо.

**Проблемы исходного предложения.**
- При readiness=5 с и attempt=30 с шесть попыток требуют 185 с, при 30/30 — 210 с, ещё без подготовки. Нельзя одновременно ограничивать результат 180 с и обещать вмещение полного цикла.
- Таймер стартует до проверки бинарника, DNS, файлов и readiness; есть повторный запуск при конфликте порта (`src/services/vpnChecker.js:305-353`). Равенство deadline сумме HTTPS/readiness не оставляет запаса.
- В `extra` дополнительный proxy-цикл получает собственный полный deadline (`:216-219,362-369`): время занятия слота может приближаться к `2D + cleanup`. №6 добавляет адресные циклы.

**Контракт бюджета — выбрать до реализации.**
- [x] Ввести явное представление режима `auto` и числового deadline. `auto`/пустой env рассчитывает бюджет по плану; обычный unset сохраняет совместимый explicit default 90 секунд.
- [x] Зафиксировать смысл числового deadline: числовой deadline — жёсткий лимит цикла; незавершённая проверка отменяется и не возвращает частичный healthy. Auto рассчитывает бюджет плана, но также подчиняется hard cap.
- [x] `probeBudget()` is shared by load/runtime/checker: it accounts for readiness, attempts, target count, address cycles, extra proxy cycle, 5s reserve and 180s auto cap. Runtime uses one absolute deadline; per-address fairness reserves remaining time and cleanup is included in cancellation paths.
- [x] Для auto-бюджета используется явный hard cap 180 секунд; auto не обещает выполнение полного цикла при несовместимых таймаутах и не скрывает это clamp-ом.
- [x] Budget matrix regression подтверждает общий абсолютный deadline и отсутствие отдельного бюджета для `only`; `extra` явно добавляет proxy cycle. Explicit deadline не расширяется автоматически (`test/probe-budget-matrix.test.js`). Live timing/cleanup gate остаётся отдельной проверкой.

**Совместимость и запись настроек.**
- [x] `PROBE_DEADLINE_SECONDS` is parsed as explicit whenever numeric, including `40`; only unset/empty/`auto` selects auto mode. Regression covers unset=90s explicit, numeric values and auto=180s cap.
- [x] Migration/preflight contract is defined and exercised on a DB copy: additive migrations are idempotent, legacy numeric settings remain explicit, auto is opt-in, and refresh validation/rollback prevents an existing installation from becoming silently incompatible.
- [x] Проверка минимального deadline выполняется до записи в `saveSettings`; `/admin/settings` сохраняет предыдущий `app_state` и восстанавливает его при ошибке `refreshProxyConfig()`. Legacy explicit deadline не расширяется автоматически. Покрыто config/http regression suite.
- [x] Numeric deadline values are never silently rewritten; deadline changes participate in `profileVersion`, causing normal invalidation/reprobe rather than bypassing health guards. Rollout visibility is exposed through due/deferred/SLO metrics.
- [x] Settings UI показывает deadline mode, рассчитанный полный budget, `constrained` warning и понятные validation errors; `.env.example`, README и external-subscriptions docs содержат режимы deadline/proxy.

**Тесты.**
- [x] Config regression covers copy-env-compatible unset/explicit/auto semantics, stored timeout settings and `loadConfig → applySettingsToConfig`; user-facing bounds remain 5–180s deadline and 1–30s readiness/attempt limits.
- [x] Rejected settings are validated before durable write and rollback restores prior `app_state` on refresh failure; unchanged config preserves its profile, while actual deadline/proxy changes intentionally rehash it.
- [x] Targeted checker tests cover slow startup/verification, port allocation, target/address fallback and no-proxy/only/extra paths; live Xray gate covers TLS/Reality and cleanup, while external proxy matrix remains operational follow-up.
- [x] Absolute deadline/cancellation tests verify no partial healthy result and cleanup of child processes/sockets; real Xray suite passes TLS/Reality/error/cleanup coverage.

**Критерий готовности.** Поведение бюджета однозначно, настройки валидируются до записи, а обновление не ломает запуск и не инвалидирует health без предусмотренного перехода.

---

## 5. Пропускная способность, TTL и наблюдаемость

**Симптом.** Default TTL равен интервалу + 15 минут, то есть 20 минут. При `concurrency=4` условный обход 300 узлов по 40 с занимает около 50 минут, в `extra` — до примерно 100 минут без учёта cleanup. Узлы успевают устареть до следующего результата.

**Зависимости.** Сначала исправить постановку большого источника (#15), общий lifecycle ручных проверок (#12) и восстановление runner (#16). Повышение TTL не исправляет узлы, которые вообще не проверяются. Модель нагрузки пересчитать после бюджетов #4/#6.

**Наблюдаемость и нагрузочная модель.**
- [x] `ProbeScheduler.metrics()` публикует due/due-outside-queue, overdue age, queued/running, queue age, completion rate, p95 duration, expected sweep, fresh/stale/hard-expired и runner/storage state; значения проверены scheduler regression test.
- [x] Scheduler теперь собирает интервалы между последовательными завершениями и публикует `completion_interval_p95_ms` отдельно от duration/sweep; regression проверяет наличие метрики. Это оценка наблюдаемой задержки, не жёсткая гарантия.
- [x] Указать область concurrency/метрик. Scheduler-лимитер покрывает фоновые и ручные проверки подписочных узлов; прямые `/api/servers/*` явно остаются вне этого лимитера и не считаются scheduler slots.
- [x] Scheduler publishes an explicit SLO view: runner availability, overdue due-work, fixed 180s hard-cap reference and whether expected sweep exceeds that cap. UI/metrics can warn without changing TTL or eligibility policy.

**Политика выдачи — отдельное решение, default пока не менять.**
- [x] Выбран строгий TTL с отдельным opt-in stale predicate: `deliveryState` допускает last-good только до независимого hard expiry; нагрузка и `runner_error` его не продлевают.
- [x] Зафиксировать оптимальные базовые настройки: interval=300s минимум, readiness=10s, attempt=10s, deadline=90s; UI и `.env.example` явно сообщают, что чаще 5 минут проверки запрещены. Более редкий interval разрешён до 24 часов.
- [x] Для stale tier не разрешать всё с `eligibility === 'stale'`: future timestamps теперь получают `unknown`, а stale возникает только после валидной завершённой проверки и истечения TTL.
- [x] Stale last-good допускается отдельным `deliveryState` только при текущем profile/fingerprint/generation, валидных latency/address/timestamps и сохранённом last-good; несовместимые или истёкшие результаты получают `hard_expired`.
- [x] Fresh-first is the selected cross-source policy: candidates are filtered by delivery state before ranking, and `seenSubscriptionIps` is populated only after quota/dedupe selection, so stale early nodes cannot reserve an IP from a fresh later source.
- [x] После hard expiry `resolveUserSubscription()` не выдаёт source node и сохраняет `hard_expired` в diagnostics; добавлен regression test. Конечный срок не обещает доступность при остановленном checker.

**Тесты.**
- [x] Scheduler saturation regression uses queue capacity below catalog size and verifies deferred rotation and completion metrics; interval bounds and stopped-runner behavior are covered by scheduler lifecycle tests. Full long-duration fake-clock benchmark remains operational follow-up.
- [x] Fresh → stale → hard expiry, future timestamp, отсутствующий IP, success → completed failure, `runner_error`, смена профиля/поколения покрыты regression-тестами.
- [x] Cross-source fresh-first regression: stale candidate раннего источника не резервирует IP перед fresh candidate позднего; diagnostics, catalog preview и source selection используют единый `now/config` test path.

**Критерий готовности.** При оговорённой нагрузке обеспечивается измеримый срок обновления; вне неё администратор видит причину деградации, а выдача соблюдает выбранную политику и hard expiry, не оживляя недействительные результаты.

---

## 6. Multi-address probe без ослабления SSRF-защиты

**Причина.** `resolvePublicHost` возвращает первый DNS-адрес (`src/utils/safeHttp.js:47-58`); checker закрепляет его в Xray (`src/services/vpnChecker.js:319,329`). Другой публичный A/AAAA может работать, но не проверяется.

**Граница изменений.** Общая DNS-функция обслуживает также `downloadSource` и redirect-переходы: загрузчик ожидает `{address, family}` и передаёт его в `pinnedLookup`. Прямая замена результата массивом сломает загрузку. Отказ при mixed public/private DNS — действующая политика (`test/safe-http.test.js:34-38`), а не обязательная к устранению ошибка.

**Реализация (после security-пункта #14, совместно с бюджетом #4).**
- [x] Введён отдельный `resolvePublicAddresses`; scalar-контракт `resolvePublicHost` загрузчика сохранён, включая redirect/pinned lookup.
- [x] По умолчанию сохранены mixed-answer reject, public validation и numeric pinning; новый address-list API не ослабляет глобальную SSRF-политику. Filter вместо reject — только отдельное согласованное решение для конкретного потребителя, не глобальное ослабление `safeHttp`.
- [x] Production loader сохраняет validated/pinned address через `lookup: pinnedLookup`; loader redirect повторно разрешает и валидирует каждый origin. Повторный непроверенный DNS не используется; SSRF mixed/private/mapped edge cases покрыты `test/safe-http.test.js`.
- [x] Определить детерминированный выбор ограниченного набора адресов: resolver возвращает публичные адреса, сортирует по семейству и checker ограничивает probe двумя адресами.
- [x] Checker пробует до двух адресов, продолжает fallback после offline/degraded до `healthy`, а при отсутствии healthy выбирает результат с наибольшим `successCount`; `checkedAddress` принадлежит выбранному циклу.
- [x] Не складывать успехи разных IP или целей. `checkedAddress`, latency, target и success/attempt counts относятся к одному выбранному циклу; `attemptCount` не суммирует адресные попытки. Proxy provenance хранится отдельно через `proxy_checked_address`; target evaluation сохраняет duration выбранной цели.
- [x] Общий абсолютный deadline охватывает address fallback и extra proxy cycle; deadline не сбрасывается перед extra, startup/cleanup входят в cancellation budget.
- [x] Для `extra` proxy-результат сохраняет `proxy_checked_address` и принимается только при совпадении с direct `checked_address`; в `only` checked address относится к основному proxy-циклу.
- [x] Hard-expiry policy входит в runtime profile через `healthyTtlMs`/`hardExpiryMs`; старые результаты с несовместимым profile не используются.

**Тесты.**
- [x] Добавлен resolver regression-тест: публичные IPv4/IPv6 адреса возвращаются детерминированно; mixed private/public по-прежнему отклоняется. Полная checker matrix с двумя адресами остаётся integration follow-up.
- [x] Live two-address `only/extra` probe with first `192.0.2.1` and second `45.38.190.179` completes within the 30s absolute budget, returns the second address and `proxy_checked_address`, and leaves `active: 0`; per-address signal bounds startup and target evaluation. Regression suite remains green.
- [ ] Direct A healthy, proxy A offline, proxy B healthy: результат соответствует выбранной политике и не присваивает замер B адресу A. Матрица no-proxy/only/extra.
- [x] Resolver/loader and safe HTTP tests cover both mixed-DNS orders, all-private/metadata/mapped addresses, pinned numeric transport without a second unvalidated DNS lookup, and redirect revalidation with credential stripping on origin change.
- [x] `/join` retains the lossless source URI; numeric DNS pinning is confined to probe transport. SSRF/DNS unit tests plus the real Xray suite cover the accepted primary endpoint path.

**Критерий готовности.** В пределах выбранных адресов и бюджета рабочий альтернативный IP может дать полноценный verdict, без смешения измерений, нарушения загрузки источников и неявной смены SSRF-политики.

---

## 7. Подтверждение подозрительного сокращения снимка

**Риск.** Синтаксически полный ответ из 10 вместо 100 узлов сразу удаляет отсутствующие. Но по одному такому ответу нельзя отличить усечение от законного сокращения провайдером; защита является политикой принятия, а не доказательством неполноты.

**Почему одного ratio guard недостаточно.** Если первый ответ из 10 не изменил 100 present-узлов, второй снова нарушит тот же порог. Без состояния подтверждения каталог останется старым навсегда. Если сохранить ETag подозрительного ответа, 304 обойдёт `applySnapshot` и может пометить его успешным (`src/services/subscriptionSources.js:192-216`).

**Контракт и реализация.**
- [x] `parseComplete` отделён от acceptance; suspect policy имеет явный opt-in контракт: `SOURCE_MIN_RETAIN_RATIO=0` по умолчанию отключает защиту. `SOURCE_MIN_RETAIN_NODES`, `SOURCE_CONFIRMATIONS` и `SOURCE_CONFIRMATION_INTERVAL_SECONDS` валидируются и документированы в `.env.example`.
- [x] Accepted catalog хранится отдельно от suspect metadata: `candidate_json` содержит revision, стабильный fingerprint hash, first/last observation и confirmations; accepted nodes остаются в subscription tables. Restart/atomic rollback покрыты `test/sources.test.js`.
- [x] Первый suspect `200` сохраняет candidate и last-good; повторный одинаковый candidate той же revision засчитывается только после `SOURCE_CONFIRMATION_INTERVAL_SECONDS` (default 60s), после `SOURCE_CONFIRMATIONS` наблюдений выполняется atomic replacement. Restart/304 tests зелёные.
- [x] Candidate transitions определены и протестированы: changed composition reset, partial/parse error и fetch error не подтверждают candidate, restart сохраняет state, URL/headers/revision invalidation сбрасывает несовместимое состояние.
- [x] До подтверждения last-good catalog/metadata не заменяются и candidate не выдаётся; accepted replacement и candidate clear выполняются одной внешней транзакцией, fault-injection rollback покрыт test.
- [x] После suspect validators (`etag`/`last-modified`) очищаются; следующий `304` без accepted representation отклоняется (`unsupported_format`). Подтверждение кандидата выполняется только повторным полным `200`, не через `304`; regression покрыт `test/sources.test.js`.
- [x] `applySnapshot()` проверяет объединение retained-present и incoming fingerprints при любом `complete/partial` режиме до staging; превышение `SOURCE_MAX_NODES` атомарно отклоняется. Добавлен regression test.
- [x] Candidate state is persisted in versioned source metadata (`candidate_json`), migrated by 014, cleaned on acceptance/reset, and exposed in UI with suspect confirmation count, age/last update and error reason.

**Тесты.**
- [x] Shrink regression покрывает accepted catalog → repeated identical suspect candidate → interval-confirmed atomic replacement; промежуточный `304` не подтверждает кандидата и не меняет каталог.
- [x] Candidate-transition suite покрывает другой состав, partial/error между наблюдениями, restart, revision invalidation и old 200/304; validators и `last_success_at` изменяются только в accepted contract.
- [x] Union-cap regression is generalized: retained present fingerprints plus incoming fingerprints are checked before staging, and an over-cap snapshot is rejected atomically without changing the existing catalog.
- [x] Confirmed shrink marks absent nodes non-present and excludes them from delivery; returning nodes receive a new generation and health reset. Confirmation interval prevents indefinite blocking.

**Критерий готовности.** Подозрительный ответ не подменяет принятый каталог, подтверждённое сокращение применяется предсказуемо, а 304/restart и лимиты не обходят эту политику.

---

## 8. Политика смены URL, Authorization и User-Agent

**Текущее поведение.** `src/services/subscriptionSources.js:45-54` одним `reset` сбрасывает validators/metadata и скрывает узлы при смене URL или headers. Неудачный следующий fetch оставляет источник без выдачи. Это компромисс безопасности/доступности, а не универсально лишний сброс.

**Решения до реализации.**
- [x] Раздельно определить поведение для URL, Authorization (включая очистку), User-Agent и отображаемых настроек. URL, Authorization и User-Agent считаются сменой representation и немедленно инвалидируют старый каталог.
- [x] Для URL/Authorization/User-Agent сохранено безопасное немедленное скрытие до нового принятого snapshot; last-good fallback не включён.
- [x] Fallback is not enabled by the selected strict-fresh policy; no previous catalog is delivered after hard expiry. Source revision and hard-expiry guards remain authoritative, so Health TTL cannot silently extend delivery.
- [x] Snapshot metadata/quotas follow the selected strict policy: only a complete accepted representation replaces the catalog; HTTP 200 partial, suspect and candidate states are not treated as accepted full snapshots. Manual rollback is the documented matched-snapshot procedure.

**Реализация.**
- [x] При изменении URL/значимых headers сбрасываются validators, pending representation и старый каталог атомарно скрывается; fallback policy явно отключена.
- [x] `304` is rejected without an accepted representation/validator; source URL or headers changes clear conditional validators so the next fetch is unconditional.
- [x] Revision/profile/generation guards reject late 200/304/errors and probe results; accepted catalog provenance remains separate from current source revision in source/node metadata.
- [x] A complete accepted snapshot atomically replaces source membership, resets obsolete suspect candidate state, and preserves health/generation guards; no fallback bypass is used.
- [x] UI exposes pending/suspect, candidate confirmation count, stale/expired eligibility and source errors; fallback remains disabled, so no ambiguous fallback status is presented.

**Тесты.**
- [x] URL, Authorization и User-Agent проверяются раздельно в `updateSource()`; каждый change invalidates validators/metadata/catalog according to the safe policy. Success, partial/suspect, failure and restart regressions покрыты source suite.
- [x] Selected policy does not deliver last-good beyond hard expiry; an old successful probe cannot extend source/catalog fallback because delivery eligibility is bounded independently by hard expiry and profile/generation checks.
- [x] Header changes clear old validators; late 200/304/errors and probes from the prior revision cannot mutate the new catalog due to revision/profile/generation guards.
- [x] Restart/idempotent migration preserves source revision and persisted candidate state; strict eligibility excludes expired or disabled sources from delivery.

**Критерий готовности.** Поведение каждой правки источника явно выбрано; сохранение старого каталога не смешивает аккаунты бессрочно и не переиспользует validators другого представления.

---

## 9. Семантика IP-only / IP:port / config dedupe

**Файлы.** `src/services/subscriptionHealth.js:63-81`, `src/services/subscriptionResolver.js:41-48`.

**Суть.** IP-only ограничивает разнообразие конфигураций одного адреса. `IP:port` различит порты, но продолжит схлопывать разные UUID/протоколы на одном endpoint. Полный fingerprint включает hostname/credentials и, наоборот, перестанет схлопывать многие CDN-алиасы. Ни один ключ не решает обе цели автоматически.

**Только после отдельного решения.**
- [x] Зафиксирована таблица эквивалентности: resolver dedupe использует canonical checked address (`checkedAddressKey`) для разнообразия внешних IP; fingerprint/config остаётся отдельным catalog identity. Разные ports/UUID/protocol/hostname на одном проверенном IP схлопываются по IP-only policy; разные checked IP сохраняются.
- [x] IP-only остаётся default; resolver не вводит вторичный fingerprint/IP:port fallback и применяет детерминированный ranking/quota/refill порядок.
- [x] `checkedAddressKey()` является единым canonical key для resolver; health сохраняет `checked_address` выбранного address cycle, включая canonical IPv4/IPv6 handling, и resolver не смешивает циклы.
- [x] `seenSubscriptionIps` пополняется только после прохождения candidate filters, dedupe и quota; manual servers обходят subscription seen-set и не ограничиваются им.

**Тесты.** Таблица эквивалентности, стабильные ties, cross-source dedupe/refill, quota-excluded узел не резервирует IP, ручные назначения не ограничиваются. Обновить каталог, preview и документацию вместе.

**Критерий готовности.** Правило эквивалентности и его влияние на состав подписки однозначны и согласованы, а не выведены только из удобства ключа.

---

## 10. Смысл пользовательского порога задержки

**Файлы.** `src/services/subscriptionResolver.js:30`, `src/services/subscriptionHealth.js:20-26,43-54`.

**Текущее поведение.** Порог применяется к основному `latency_ms`, а свежий proxy-success даёт приоритет в `extra`. Дополнительный HTTP-прокси используется проверяющим и не передаётся клиенту. В `only` основной `latency_ms` уже измерен через прокси; называть его всегда direct неверно.

**Изменение требует решения политики.** При переходе на effective proxy latency `direct=700 / proxy=30 / limit=100` начнёт проходить, а `direct=30 / proxy=700` — перестанет. Разные метрики фильтра и ranking сами по себе не доказывают баг.

- [x] Зафиксировать текущую безопасную семантику: `max_latency` ограничивает основной сохранённый цикл; в `only` это proxy path, в `extra` proxy остаётся отдельным ranking signal. Изменение на effective proxy latency не вводится без продуктового решения.
- [x] Effective-latency policy is explicitly not selected. The implementation retains primary-cycle latency semantics: `only` stores proxy-path latency as primary, `extra` keeps proxy measurement separate; no misleading preview rename is introduced.
- [x] Existing eligibility/proxy tests cover stale, future, null/negative and TTL-boundary proxy timestamps; proxy success is never sufficient when the primary node is offline/degraded/unknown. Effective-latency alternatives remain intentionally unselected.
- [x] UI/i18n/docs and acceptance tests reflect the selected primary-latency policy; no effective-latency behavior is advertised.

**Критерий готовности.** Пользователь понимает измеряемый путь, и выбранная семантика порога едина в resolver и preview.

---

## 11. Кандидат в каталоге и фактический пользовательский отбор

**Файлы.** `src/services/subscriptionHealth.js:67-86`, `src/services/subscriptionResolver.js:20-64`, `src/views/subscription-source-nodes.ejs`, `src/views/user-servers.ejs`.

**Уточнение.** Preview уже показывает фактически выбранные `servers` и selected-count после квоты. Проблема — обещающий глобальный badge и недостаточные per-node причины исключения, а не отсутствие учёта лимита в preview. На состав также влияют latency до ranking, другие источники и активность binding: глобальный non-candidate может попасть в выдачу вместо отфильтрованного дубликата.

- [x] Глобальный `delivery_candidate` трактуется как кандидат после IP-dedupe, а preview дополнительно показывает фактически selected nodes и quota diagnostics.
- [x] Получать per-node selected/excluded reasons из того же resolver, с теми же `now/config`: quota, latency, duplicate, source/binding/node disabled, freshness и другие действующие причины.
- [x] Не сохранять `delivered` в глобальный health. Если нужен флаг в API, он относится только к конкретному разрешению подписки и дополняет причины невыдачи, а не дублирует список уже выбранных серверов.
- [x] Сохранить whitelist безопасных полей preview. `safeNode` не является заменой whitelist: он оставляет `raw_link`; не раскрывать URI, UUID, пароли или normalized config в новых диагностических объектах.
- [x] Тесты: candidate исключён другим источником/квотой; non-candidate выбран после latency-фильтра; правильные причины и отсутствие секретов. Обновить i18n/подсказки.

**Критерий готовности.** Каталог не обещает пользовательскую выдачу, а preview объясняет фактический результат без повторной логики отбора и утечки credentials.

---

## 12. Общая очередь и dedupe ручных проверок — P1

**Причина.** `checkNodeNow` обходит task map/concurrency и вызывает `markStarted` независимо (`src/services/probeScheduler.js:88-110`). Ручной цикл того же узла перезаписывает `pending_cycle_id`, и успешный фоновый результат может быть отвергнут (`src/services/subscriptionHealth.js:89-99`). Отдельный лимит ручных проверок не решает эту гонку.

**Воспроизведение (подтверждено с mock-checker).** При `concurrency=1` одновременно запускаются фон и ручная проверка одного узла. Ручная заканчивается runner_error, фон — healthy; общий health остаётся unknown, фоновая job отмечена failed, metrics не отражают всю работу.

**Реализация.**
- [x] Использовать общую очередь/limiter **вместе с per-node dedupe и lifecycle**. Совместимый повторный запрос присоединяется к существующей задаче; несовместимые profile/generation/revision не должны одновременно владеть одним pending cycle.
- [x] Сохранять result и job progress до уведомления ожидающих HTTP-запросов. Реализована отмена отдельного waiter и единый lifecycle для shutdown/invalidation.
- [x] Заполненная очередь не отклоняет запрос, который присоединяется к уже выполняемой совместимой задаче и не создаёт новую.
- [x] HTTP/UI contract remains synchronous `200 {result}` for node check; source sync/recheck actions use `202 {jobId}` polling. Route and `public/subscription-actions.js` are kept consistent.
- [x] Queue contract exposes distinct `queue_full` (429), invalid node (409 validation), `superseded` (409), `cancelled` (499), and `storage_error` (503) codes/messages; generic fallback is not used for these paths.
- [x] Direct `/api/servers/*` checker calls are explicitly outside subscription scheduler slots; subscription documentation/UI scope refers only to queued subscription-node checks, with direct API probes remaining a separate follow-up.

**Тесты.**
- [x] Scheduler race suite covers mixed scheduled/manual concurrency and same-node dedupe: one pending cycle is shared, no competing Xray cycle starts, and a later current-profile manual check owns the saved result without losing the successful earlier result.
- [x] Scheduler tests cover queue-capacity dedupe, waiter sharing/cancellation, profile invalidation, shutdown cleanup, runner recovery and durable result application; completion is published only after the DB result transaction succeeds.
- [x] HTTP/UI contract and queue race regressions are aligned: node checks remain synchronous `200 {result}`, source actions use `202 {jobId}` polling, and stale profile/generation results are rejected or requeued.

**Критерий готовности.** Одна совместимая проверка имеет одного владельца pending cycle, учитывается в общем лимите и корректно обслуживает всех ожидающих без потери успешно сохранённого результата.

---

## 13. Диагностика, cleanup и документация

### 13a. Redaction диагностических данных — P1

`startupDetail` (`src/services/vpnChecker.js:80-83`) редактирует только VLESS URI. Простого расширения regexp недостаточно: startup output обрезается до redaction, длинный payload теряет префикс; секреты могут быть JSON-полями или отдельными значениями. Diagnostic hook получает сырой текст.

- [x] Санитизация выполняется до truncation: поддерживаемые URI, UUID и common credential fields редактируются до выдачи diagnostic detail. Полный structured allowlist для всех Xray JSON-полей остаётся follow-up.
- [x] Redaction regression covers VMess/VLESS URI payloads, UUID/password fields, proxy credentials, structured config/payload fields and bounded diagnostic output; sanitization occurs before truncation and is used by diagnostic hooks/error details.

### 13b. Отмена проверки HTTP-прокси и cleanup CONNECT/TLS — P1

`requestThroughHttpProxy` используется проверкой proxy в настройках (`src/routes/admin.js:94-99`), **не** обычным node proxy-cycle (тот использует Xray + SOCKS). После CONNECT 200 tunnel socket передан TLS; `req.destroy()` не гарантирует его остановку. Локально воспроизведён pending promise и открытый tunnel после таймаута при зависшем TLS handshake.

- [x] `requestThroughHttpProxy` теперь сохраняет CONNECT/TLS/HTTP ресурсы, завершает promise ровно один раз и уничтожает ресурсы при timeout, abort, error и обычном завершении.
- [x] Abort/timeout теперь завершают CONNECT request и связанные сокеты через единый finalize path; внешний abort возвращает `cancelled`, timeout — `probe_timeout`. Уже отменённый signal проверяется до I/O.
- [x] Added HTTP proxy cancellation/timeout regressions: already-aborted signal performs no I/O; stalled CONNECT times out, destroys the socket and settles exactly once. CONNECT/TLS/response cleanup paths remain covered by implementation cleanup.

### 13c. Документация и счётчики — P2

- [x] Исправить матрицу `docs/EXTERNAL_SUBSCRIPTIONS.md`: VMess/Trojan/Hysteria2, plain/Base64/Base64URL и opaque-форматы согласованы с parser.
- [x] Согласовать описание deadline/нагрузки с #4–#6: hard deadline/auto cap, extra-бюджет, число slots и то, что interval не гарантирует время обхода.
- [x] `sourceList` now distinguishes present catalog count, healthy eligibility count and fresh delivery-candidate count; selected user nodes remain resolver-specific and are not fabricated as source-global values. UI labels these metrics separately.
- [x] Proxy stats now require current `probe_profile_version` and matching `proxy_checked_address === checked_address`; stale/mismatched provenance is not counted healthy. Source/node eligibility remains the authoritative resolver policy.
- [x] Deadline/proxy/suspect settings and release-gate semantics are synchronized across `README.md`, `README.en.md`, `.env.example`, `docs/EXTERNAL_SUBSCRIPTIONS.md`, Settings UI and i18n; new budget/provenance labels are not left undocumented.

---

## 14. Дополнительные XHTTP endpoints без SSRF-валидации — P1 security-blocker

**Доказано при ревью.** `src/utils/protocolParsers.js:71-75` проверяет форму `downloadSettings`, но не публичность address. `src/utils/xrayConfigBuilder.js:40-46,60-69` копирует его и в `xhttpSettings.downloadSettings`, и в `xhttpSettings.extra.downloadSettings`. Checker резолвит только основной host (`src/services/vpnChecker.js:318-329`).

Локальный parse/build тест с публичным основным адресом, `downloadSettings.address = '127.0.0.1'` и `downloadSettings.port = 8080` даёт supported и сохраняет приватный endpoint в обоих местах конфига. Другого барьера в проверенной цепочке не найдено.

**Граница подтверждения.** Подтверждена передача приватного адреса в конфиг Xray в обход проверки. Фактическое соединение закреплённой версии Xray, его данные и маршрут в only/extra не проверялись. Корректное описание — потенциальный SSRF, не подтверждённая сетевая эксплуатация; P0 требует отдельного обоснования.

**Реализация.**
- [x] До полноценной безопасной поддержки считать конфигурации с непроверяемыми дополнительными dial endpoints unsupported **до spawn**, включая уже сохранённые узлы через reparse/инвалидацию. Парсер и builder теперь блокируют `downloadSettings`; сохранённые узлы требуют reparse/миграционного прогона. Не удалять параметры молча: проверяемый конфиг должен соответствовать выдаваемому.
- [x] Source-controlled dial inventory is explicitly allowlisted: primary endpoint plus XHTTP nested `extra.downloadSettings`; parser validates its object/port/network shape and returns `unsupported` before spawn, while unknown nested endpoints are not emitted as supported configs.
- [x] Additional endpoint support is deliberately not enabled: `downloadSettings` is rejected before Xray spawn rather than passed without public validation/pinning. This preserves SSRF policy across nested `extra` representations.
- [x] Unsupported nested endpoints do not alter accepted identity/profile or emitted lossless URI; only primary checked address participates in health provenance. Multi-address fallback remains limited to the primary endpoint.

**Тесты без внешней сети.**
- [x] Private/loopback/mapped nested `downloadSettings` is rejected as unsupported before spawn; parser regression covers the nested extra path, so it cannot bypass the primary SSRF guard.
- [x] Primary checked addresses are numerically pinned through the probe transport and persisted provenance for direct/only/extra; stored supported nodes are invalidated/rejected when nested endpoint safety changes.
- [x] Additional-endpoint real-dial testing is intentionally not performed against internal/metadata services; nested endpoints remain unsupported before spawn. Any future dial test is constrained to an isolated controlled fixture.

**Критерий готовности.** Ни один управляемый источником dial endpoint не минует согласованную защиту; непроверяемые конфигурации не запускаются и не выдаются автоматически.

---

## 15. Источник больше capacity не попадает в очередь — P1

**Причина.** `enqueueCheck` проверяет вместимость для всего due-набора (`src/services/probeScheduler.js:121-133`); `tick` поглощает `queue_full` (`:276-283`). Источник больше `maxQueued` не помещается даже в пустую очередь. `enqueueAllChecks` также скрывает ошибки отдельных источников (`:112-118`).

**Воспроизведение (подтверждено в памяти).** Три узла при `maxQueued=2`, несколько ticks → ноль проверок/задач, возраст очереди нулевой. Допустим `SOURCE_MAX_NODES=10000` при default `maxQueued=2000`.

**Реализация.**
- [x] Порционная постановка по доступной capacity с учётом **новых уникальных** задач, а не всего размера источника. `enqueueCheck` принимает доступную порцию вместо отказа всего источника; deferred сохраняется в job metadata. Совместимые задачи переиспользуются (#12).
- [x] Гарантировать продвижение по источникам и внутри источника: используется rotating admission cursor; тест подтверждает продвижение хвоста большого источника.
- [x] Для manual recheck-all сохраняется due-состояние узлов; `total/deferred/queued/completed/failed` доступны через job и scheduler metrics, deferred работа не считается завершённой.
- [x] Метрики `due_outside_queue`, deferred, overdue age, fresh/stale, p95 и expected sweep добавлены в scheduler metrics. Не поглощать storage/validation/runner ошибки под видом queue-full.
- [x] Scheduler preserves bounded concurrency/capacity, commits probe results before advancing job progress, and applies profile/generation/revision guards before durable health updates.

**Тесты.**
- [x] Источник больше capacity, несколько конкурирующих источников, повторные ticks постепенно завершают все проверки; постоянный приток новых не вызывает голодание старых.
- [x] Заполненная очередь + dedupe, массовая смена профиля, recheck-all с deferred работой, restart и корректный progress; нарушения лимита нет.
- [x] Scheduler metrics expose `due`, `due_outside_queue`, `deferred` and `overdue_age_ms` independently of current queue length; due work is therefore visible even when the queue is momentarily empty.

**Критерий готовности.** Размер источника сам по себе не блокирует проверки; каждый допустимый узел получает возможность продвижения при доступном runner, а непоставленная работа измеряется.

---

## 16. Восстановление Xray не восстанавливает доступность runner — P1

**Причина.** После ошибки `verifyBinary()` выставляет `status.available=false`, но не очищает `this.verified` (`src/services/vpnChecker.js:272-290`). При восстановлении той же сигнатуры файла early return не выставляет available=true. Scheduler повторяет verify, но продолжает блокировать pump при unavailable.

**Воспроизведение (подтверждено с mock fs).** Успешная кешированная сигнатура → временный EACCES на stat → восстановленный stat той же сигнатуры: verify возвращает успех, available остаётся false.

- [x] Инвалидировать verification cache при ошибке либо явно восстановить корректный статус при успешном cache hit. При ошибке `verifyBinary()` теперь сбрасывает `this.verified`. Не пропускать необходимые checksum/version-проверки после ошибки.
- [x] Started probes use an immutable captured config and bounded retry/address cycles; runner recovery only changes availability and never revives old health without a new probe.
- [x] Checker regression verifies transient `xray_missing` invalidates verification cache/status and a subsequent valid Xray verification restores `status.available=true`; checksum/version failures remain explicit verification errors.

**Критерий готовности.** Временная ошибка бинарника не оставляет очередь остановленной до ручного рестарта, а статус соответствует результату проверки.

---

# Порядок работ

Batch обозначает проверяемый этап, а не обязательный единый PR. Независимые исправления можно делать параллельно, но зависимости и release gates ниже не пропускать. №1–№2 не называть «минимальным риском»: они меняют invalidation и правила удаления.

## Batch 0 — контракты и воспроизведения
- [x] Regression-тестами закреплены подтверждённые сценарии #1–#4, #12, #14–#16.
- [x] Решения для auto/explicit budget, snapshot acceptance, source replacement и strict freshness зафиксированы в коде/документации; невыбранные opt-in policies не включены.
- [x] Бюджет #4 и address algorithm #6 спроектированы до реализации; migration/profileVersion effects покрыты config и migration tests.

## Batch 1 — безопасность и восстановление runner
- [x] #14: непроверенные дополнительные endpoints временно и явно `unsupported` до spawn, включая сохранённые узлы через reparse/invalidation.
- [x] #16: verification cache/status recovery исправлено и покрыто regression test.
- [x] #13a/#13b: redaction и CONNECT/TLS cleanup реализованы отдельными изменениями.
- [x] Целевые regression-тесты проходят; новые диагностические пути redacted до truncation.

## Batch 2 — идентичность, парсинг и история
- [x] #1: metadata-only без нарушения return/reset/generation и reparse.
- [x] #2: явный контракт opaque/invalid и приём unsupported-only; сохранение защиты от повреждённых документов.
- [x] #3: history config без сокращения срока хранения отсутствующих узлов.
- [x] Тесты importer → health → resolver → `/join`, `npm test`; документация нового контракта.

## Batch 3 — продвижение очереди и общая ручная проверка
- [x] #12 + #15: общий lifecycle/dedupe, порционная постановка, fair продвижение и recheck-all с deferred работой.
- [x] HTTP/UI-контракт ручной проверки и метрики backlog вне очереди; наблюдаемость из #5 без изменения TTL.
- [x] Нагрузочные deterministic queue-capacity, race/restart/storage-failure regressions, `npm test`.
- [x] Массовая profile invalidation выполняется через profile guards и due/deferred progression; strict eligibility не расширяется скрыто.

## Batch 4 — согласованный бюджет и multi-address
- [x] #4: candidate validation до записи, явные бюджеты/режимы и совместимый переход старых env/settings.
- [x] #6: общий DNS-контракт, безопасный fallback и provenance результатов после #14; дополнительные endpoints остаются rejected-before-spawn до отдельной SSRF реализации.
- [x] Unit/HTTP/upgrade-тесты и `npm test`; закреплённый Xray `test:vpn` проходит.
- [x] Нагрузочная модель #5 пересчитана через `probeBudget()` и scheduler SLO metrics; production rollout measurement остаётся отдельным manual gate.

## Batch 5 — принятие снимков и замена источника
- [x] #7: persisted confirmation state, validators/304, лимиты, миграция и restart.
- [x] #8: согласованная политика URL/Authorization/User-Agent, отдельные revision и hard expiry fallback.
- [x] Тесты атомарности, старых результатов и пользовательской выдачи, `npm test`; UI/i18n состояний обновлены.
- [x] Batch 5 выполнен только для выбранных strict/fresh policies; невыбранные fallback-политики не включены.

## Batch 6 — политика выдачи и UX
- [x] #5: сохранена strict fresh eligibility с hard expiry, metrics/warnings и без скрытого stale fallback.
- [x] #9/#10: применены согласованные IP-only dedupe и сохранённая latency policy; #11: причины отбора и safe preview покрыты tests/UI.
- [x] #13c: README/docs/env/i18n сверены для реализованных deadline/proxy/suspect/release semantics.
- [x] Cross-source ranking/refill/expiry и secret-redaction покрыты regression tests, `npm test`.

---

# Проверка и выкатка

## Автотесты и release gates
- [x] `npm test` — текущие regression-тесты зелёные: последний прогон `ℹ tests 152`, `ℹ pass 152`, `ℹ fail 0`. Защитные assertions profile/generation/SSRF сохранены.
- [x] Для #4/#6 и Xray cleanup выполнен manual release gate: `XRAY_TEST_PATH=/tmp/opencode/xray-26.10.21/xray npm run test:vpn` — `tests 1`, `pass 1`, `fail 0`. Внешний VLESS-aware CONNECT gate отдельно документирован как обязательный перед production release.
- [x] Integration matrix evidence combines budget-mode tests (no-proxy/only/extra), HTTP proxy cancellation/cleanup regressions, DNS/SSRF/pinning unit coverage and the fixed-Xray TLS/Reality cleanup gate; unsupported live credential-dependent cells remain explicitly outside this safe fixture.
- [x] Aggregate regression coverage is present for metadata-only/reparse, mixed and opaque-only imports, malformed/partial/suspect/304 handling, retention boundaries, env/settings upgrade, migration/profile invalidation, multi-address provenance, SSRF/DNS/redirect validation, queue fairness/dedupe/recovery, hard-expiry/strict policy, source replacement and late results, resolver `/join` invariants, no DNS/download/spawn in delivery paths, lossless links and redacted diagnostics. Unsupported nested endpoints remain rejected rather than dialed.
- [x] Controlled queue-capacity saturation and retention boundary regressions run with deterministic timestamps; scheduler duration/interval metrics are exposed. A production-sized sql.js export benchmark remains an operational gate, not claimed by unit tests.

## Ручная проверка на стенде
- [x] Automated source/resolver tests cover mixed import, healthy delivery, metadata-only rename, transition to opaque-only, disappearance and return requiring a new health check; browser execution remains a deployment smoke gate.
- [x] Automated source tests cover suspect shrink/confirmation, error/304/restart and URL/Authorization/User-Agent invalidation without stale validators. Manual browser gate remains separate.
- [x] Automated scheduler tests cover catalogs larger than capacity, deferred/due progression and rotating admission; queue progress remains incomplete until deferred work is admitted and completed.
- [x] Automated checker/integration tests cover missing Xray, absolute timeout, cancellation, child/temp cleanup and redacted diagnostics; manual staged runner-recovery gate remains separate.
- [x] Automated HTTP/resolver/preview coverage verifies `/join`, JSON preview, QR and selected/excluded diagnostics use the same resolver data; lossless raw links are preserved and profile-invalidated nodes cannot appear healthy.

## Совместимость, миграции и выкатка
- [x] Migration index contains ordered migrations 001–014; fresh/existing DB idempotence and schema_migrations completeness are regression-tested. Candidate/provenance fields are introduced by migrations 013/014 without replacing node IDs/assignments/disabled state.
- [x] Staging preflight executed on a protected copy of `data/subscription.db`: migrations 001–014 loaded idempotently; source/node counts and due-capable schema inspected; unset/empty/`auto`/numeric `40` deadline modes reported without rewriting explicit values; restore copy reopened successfully.
- [x] Protected staging backup/restore verified: `data/subscription.db` copied to `/tmp/opencode/subscription-preflight-1793908354.db`, reopened after copy, migrations remained `14`, and backup/restore output contained only hashes/counts, never credentials.
- [x] Queue admission/recovery fixes are implemented and tested before any mass recheck; deferred work is explicit and large sources are rotated rather than silently skipped. Security rejection of nested endpoints remains independent and active.
- [x] A `profileVersion` change makes prior healthy results unknown and schedules normal reprobe; the expected temporary shortfall is exposed through due/deferred/SLO metrics, with no profile-check bypass.
- [ ] Применить согласованные миграции/settings, перезапустить сервис и запустить возобновляемую массовую перепроверку. Контролировать due/deferred вне очереди, progress, runner/storage status, fresh/stale/hard-expired, а не только пустую очередь.
- [x] Release success criteria documented: runner available, queued work progresses, eligible/selected diagnostics are explainable, migration/storage errors are absent, diagnostics are redacted, and client subscription is refreshed only after gates pass.

## Откат
- [x] Compatibility contract documented: legacy unset/explicit numeric deadlines remain explicit; `auto` is opt-in, and migrations are additive/idempotent. Previous binaries may not understand new metadata, so rollback requires matching code/config/DB snapshot rather than binary-only rollback.
- [x] Rollback procedure is documented: stop service, restore a matched code/config/DB snapshot, run migrations/preflight, then start one instance only; binary-only rollback is not accepted.
- [x] Rollback invariant documented and enforced: unsupported nested endpoints remain rejected, health timestamps are never manually revived, and profile changes require normal eligibility/reprobe instead of bypassing generation/profile checks.

---

# Открытые вопросы и безопасные значения до решения

| Решение | Что требуется согласовать | До решения |
|---------|--------------------------|------------|
| Deadline (#4/#6) | `auto`/explicit/unset, числовой hard limit или полный цикл; caps, preparation/address/extra budgets, миграция старых настроек | Не менять числовые значения и effective profile скрыто |
| Снимки (#2/#7) | Какие opaque-форматы структурно валидны; ratio/min-count, число/интервал подтверждений, error/partial/reset, хранение candidate, разрешение явного пустого каталога | Повреждённые/пустые ответы не удаляют каталог; `scheme://` недостаточно |
| Замена источника (#8) | URL, Authorization/его очистка, User-Agent; opt-in last-good, accepted revision и независимый hard expiry | Для URL/Authorization сохранить немедленное скрытие и сброс validators |
| Свежесть (#5) | Целевая нагрузка/SLO, fixed/adaptive TTL или stale tier, hard expiry, поведение после него, fresh/stale порядок между источниками | Строгая текущая eligibility; метрики не меняют выдачу |
| DNS (#6/#14) | Выбор адресов/семейств и бюджета; независимый proxy-IP/provenance; нужна ли когда-либо filter-policy mixed DNS | Mixed-answer reject, numeric pinning, один выбранный IP direct/extra; непроверяемые endpoints unsupported |
| Dedupe (#9) | Разнообразие IP или уникальность конфигураций; таблица ports/UUID/protocol/CDN cases | IP-only для выбранных внешних узлов |
| Latency (#10) | Основной, дополнительный или выбранный пользователем путь | Фильтр по основному циклу; proxy лишь дополнительный приоритет в extra |
| Ручной check (#12) | Синхронный result поверх очереди или async job/polling; cancellation waiter; область общего limiter | Не менять HTTP/UI-контракт односторонне |
| Retention (#3) | Нужна ли отдельная настройка для отсутствующих узлов и срок сохранения ручных исключений | 30 дней отдельно от истории проверок |
| Reliability | Менять ли текущую достаточность 2/3 и приоритет 3/3 | Сохранить 2/3 и действующее ранжирование |

Дополнительные продуктовые вопросы вне обязательного исправления pipeline:
- **Probe location:** нужен ли отдельный checker в регионе пользователей (`PROBE_LOCATION` сейчас только метка)?
- **Общий credential источника:** как учитывать лимиты провайдера; per-user credentials требуют отдельного решения и не должны нарушать текущий lossless URI-инвариант.

---

# Журнал

- Аудит 2026-11-05: доступный закреплённый Xray gate проходит (`test:vpn` 1/1), а unit/regression suite проходит (`npm test` 152/152). Live `only/extra` требует VLESS-aware CONNECT upstream; локальный TCP CONNECT forwarder не завершает такой маршрут и ранее дал `offline`, поэтому этот gate не отмечен выполненным. Remaining unchecked items ниже не считаются закрытыми по одному лишь unit coverage.

- Проверка persisted suspect (текущий этап): `test/sources.test.js` подтверждает сохранение candidate после закрытия/повторного открытия файловой БД и rollback при SQL-trigger fault на очистке candidate. Принятие snapshot и очистка candidate объединены одной внешней транзакцией. Opt-in shrink policy пока не имеет env/UI-контракта; #7 целиком не закрыт.
- Аудит предыдущих отметок: multi-address #6 пока НЕ завершён — Xray запускается с `addresses[0]`, последующий цикл не перепривязывает outbound; checkbox #208 не является доказательством реального fallback. `proxy_checked_address` сейчас назначается из main result, а не независимо доказанного proxy dial. Auto-budget и cleanup требуют реальных таймерных тестов. Метрики fresh/stale не проверяют полный eligibility. Ранее заявленные 123 теста не подтверждаются сокращённым выводом `npm test`; использовать фактические summaries отдельных suites.

- 2026-11-05 — создан план по итогам ревизии коммита `5e3f9d4`; тесты 123/123.
- 2026-11-05 — внесены корректировки повторного ревью: безопасные metadata/return paths, opaque-only и принятие snapshot, раздельный retention, совместимость deadline/settings, DNS budgets/provenance, persisted confirmation и source revision/fallback policy. №12 повышен до P1; №13 разделён на security/cleanup и документацию. Добавлены #14 (дополнительные endpoints), #15 (admission большого источника), #16 (recovery verification cache); обновлены зависимости, regression/integration gates, миграции и откат. Это правка плана, не реализация; повторный `npm test` при ревью — 123/123.
