# Пользовательские группы классификации — backend v3

## Граница изменения и совместимость

Это добавочный протокол, не новый баланс. Любое выбытие остаётся расходом (−),
любое поступление — доходом (+), включая займы, возвраты и инвестиции. Группа
не меняет сумму, дату, знак, источник или участие операции в денежных итогах.
Expense/income документы, старый баланс, P11, подтверждение C и DTO v1/v2 не меняются.
Нет фонового применения правил, автоматической переклассификации и backfill.

Единственная авторитетная запись — прежняя `operation_classifications`, с прежним
уникальным ключом `(owner, dataset, operationId)`. Новая taxonomy
`financial-classification-groups-v3` хранит `groupId` вместо `assignment`.
Старая ветка MongoDB validator включена в union **без изменений**. Старые документы
не переписываются; новое подтверждённое действие может заменить ровно одну запись,
сохраняя её `_id`, `createdAt` и увеличивая общую `decisionRevision` через CAS.
Никаких фиктивных `layer`/`economicRole` для пользовательских групп.

Старые read/write DTO остаются строгими: старый reader возвращает существующий
`blocked` для новой taxonomy, старый writer не перезаписывает её. Поэтому текущий
frontend продолжает прежнюю работу с v1/v2 при выключенном новом протоколе.
**Включать v3 для пользователя можно только после перевода его frontend на новые
read/write/report/rules API.** Нельзя обещать отображение custom-группы старым DTO.
Старый `/classification-rules` показывает/изменяет только legacy-правила; правила,
явно переведённые в v3, видны и редактируются через новый API. Это предотвращает
перезапись назначения устаревшим клиентом. Seed пропускает существующий ключ любого
формата и не заменяет его. Восемь исходных правил продолжают работать без конверсии.

## Группы и индексы

`classification_groups`:
`_id`, `owner` (ObjectId), `dataset`, `groupId`, `name`, `normalizedName`,
`origin` (`system|custom`), `status` (`active|disabled|archived`),
`revision` (целое ≥1), `createdAt`, `updatedAt` (BSON Date).

- Primary system expenses: `system:expenses:{everyday,irregular,emergency,major_goals,long_term_capital}`.
- Primary system incomes: `system:incomes:{ordinary_income,loan_repayment,refund,internal_transfer,capital_movement}`.
- Исторические v1 role-only расходы отображаются в отдельные стабильные
  `system:expenses:role:{loan_issuance,internal_transfer,capital_movement}`.
  Эти три compatibility-группы изначально disabled; они не подменяют обычные пять
  слоёв и не исключают операции из отчётов. Существующие v1 ссылки читаются даже
  до инициализации каталога через virtual metadata (`revision:0, virtual:true`).
- Custom: `custom:<lowercase UUIDv4>`, генерируется сервером. Dataset/ID/owner/origin
  неизменяемы. Переименование меняет только metadata, ссылки сохраняются.
- Имена: точная отображаемая строка без крайних пробелов, 1–120 UTF-16 units,
  ≤480 UTF-8 bytes, без control/lone-surrogate. Нормализация уникальности —
  `trim().toLowerCase()`, без Unicode normalization. Регистр не создаёт новую группу.
- Уникальные simple-collation индексы: `ux_group_owner_identity (owner,groupId)` и
  `ux_group_owner_dataset_name (owner,dataset,normalizedName)`. Disabled/archived
  имена тоже заняты. Дубликат — 409, а не скрытое переименование.
- DELETE custom всегда soft archive, даже без ссылок. System нельзя удалить или
  архивировать; можно отключить/восстановить и сбросить имя. Исторические ссылки
  разрешаются и после archive/rename. System-настройки строго per owner.

`operation_classifications`: исходный unique index и строгий union validator.
`classification_rules`: исходные два unique partial индекса expense match и income
source; строгий validator legacy/v3. В v3: `version:3, groupId, revision`, без
`economicRole/layer`. В обоих форматах запрещены неожиданные поля и смешанные datasets.
Импорт/factory/readiness никогда не создают коллекции/индексы; readiness проверяет
точный validator, strict/error, collation и полный набор индексов без TTL/hidden/sparse.

## Защита и activation gates

Все маршруты ниже — под существующим JWT middleware. Дополнительно проверяются
`_id`, expiry и существование пользователя; owner из body/query запрещён.
Новая настройка `CLASSIFICATION_GROUPS_ENABLED=1` **по умолчанию выключена**.
Решения дополнительно требуют `CLASSIFICATION_C_WRITE_ENABLED=1`, чтение операций
и reconcile — `CLASSIFICATION_READ_ENABLED=1`, report/preview —
`CLASSIFICATION_HISTORY_READ_ENABLED=1`. Readiness всех трёх manifest обязательна.
Эта работа не включает flags, deployment или миграцию пользовательской БД.

Общий transport: bounded JSON 8 KiB/depth16, отказ от duplicate keys, unsupported
media/encoding и неизвестного Origin; прежняя CORS/origin policy сохранена.
Общий admission limiter: 600 запросов/owner/min, 4 concurrent/owner, 16 total,
4096 owner slots на процесс. 429 не означает разрешение повторить финансовую запись.
Ответы `Cache-Control:no-store`, `Vary:Authorization`. Логи используют прежний safe
allowlist; Mongo errors, факты и credentials в error DTO не возвращаются.

## HTTP-контракт

Все пути относительно `/classification-groups`. Успех:

```json
{"version":"classification-groups-v3","result":{}}
```

Ошибка (стабильные безопасные коды, без сообщения MongoDB):

```json
{"version":"classification-groups-v3","error":{"code":"revision_conflict"},"persistence":"not_applied"}
```

400 — неверные DTO/identity/период/лишние поля; 401 — auth/session/owner;
404 — источник/собственная группа/правило отсутствует (также чужой ресурс);
409 — duplicate/CAS/facts/неактивная группа; 503 — gates/readiness/invalid persisted
record/инфраструктура/неподтверждённый результат. Transport также 403/413/415, limiter429.
У всех write ошибок после отправки записи, кроме подтверждённого CAS miss/duplicate,
`persistence:"unknown"`; нельзя выводить из HTTP503, что запись не произошла.

### Каталог

| Метод / путь | Тело / query | Результат |
|---|---|---|
| GET `/` | `dataset?`, `after?` (BSON `_id` cursor), `limit?` (1–100, default100) | `groups`, `nextCursor`, `initialized`, `systemDefinitions` |
| POST `/initialize` | `{}` | `{"initialized":true}`; явная идемпотентная per-owner инициализация 13 system rows, без изменения существующих |
| POST `/` | `{"dataset":"expenses","name":"Автомобиль"}` | 201, group DTO |
| PATCH `/:groupId` | `{"expectedRevision":1,"name":"Семья","status":"active"}` | group DTO, CAS revision+1 |
| PATCH `/:groupId` | `{"expectedRevision":2,"resetName":true}` | исходное system name; несовместимо с `name` |
| DELETE `/:groupId` | `{"expectedRevision":3}` | group DTO status archived, без физического удаления |

Group DTO:

```json
{"groupId":"custom:10000000-0000-4000-8000-000000000001","dataset":"expenses","name":"Автомобиль","origin":"custom","status":"active","revision":1,"createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"}
```

GET не пишет. Для создания custom/назначений system сначала explicit initialize.
Инициализация может частично завершиться при инфраструктурной ошибке; повторное
явное initialize безопасно, т.к. использует только `$setOnInsert`.

### Чтение, подтверждение и reconciliation

`GET /operations/:dataset/:operationId` возвращает `classification-group-read-v3`:

```json
{"version":"classification-groups-v3","result":{"version":"classification-group-read-v3","dataset":"expenses","operationId":"111111111111111111111111","facts":{"amount":{"format":"binary64-roundtrip-decimal","value":"12.34"},"dateEpochMs":1736942400000,"date":"2025-01-15T12:00:00.000Z","category":"Транспорт","title":"Топливо","recipient":"Synthetic","comment":{"kind":"missing"}},"sourceFingerprint":"<64 lowercase hex>","sourceFingerprintVersion":1,"decisionRevision":null,"status":"unreviewed","storedState":null,"storedGroupId":null,"groupId":null,"group":null,"legacy":false,"consistency":"observed_only_non_atomic"}}
```

Frontend показывает **эти точные факты**, группу и ожидаемую revision и лишь после
явного действия пользователя отправляет `PUT /operations/:dataset/:operationId/decision`:

```json
{"version":"classification-group-decision-v3","requestId":"10000000-0000-4000-8000-000000000002","expectedRevision":null,"state":"approved","groupId":"custom:10000000-0000-4000-8000-000000000001","expectedFacts":{"amount":{"format":"binary64-roundtrip-decimal","value":"12.34"},"dateEpochMs":1736942400000,"date":"2025-01-15T12:00:00.000Z","category":"Транспорт","title":"Топливо","recipient":"Synthetic","comment":{"kind":"missing"}}}
```

Успех200: `result:{outcome:"created|updated|replayed", decision:<read DTO>}`.
Для дохода `facts` содержит `source` вместо category/title/recipient. `expectedFacts`
обязателен и точно сравнивается; missing/null/value comment не взаимозаменяемы.
`expectedRevision:null` — только отсутствующая запись, далее positive revision.
Reset: `state:"explicit_unclassified"` (явный отказ) или `"cleared"` (снятие решения),
**без** `groupId`. Источник никогда не PATCH-ится этим протоколом.

Проверяются owner/dataset/group active, source fingerprint до и непосредственно
перед записью, revision CAS, majority acknowledgement, post-write read и group revision.
Одинаковый последний requestId с тем же canonical intent воспроизводит результат без
новой записи/revision; иной intent с этим ID — 409. Более старый request после нового
решения также конфликтует по revision, а не отменяет новое решение. Финансовая запись
не повторяется автоматически ни при каких HTTP ошибках.

`POST /operations/:dataset/:operationId/reconcile` принимает **тот же DTO намерения**.
Ответ `result:{version:"classification-group-reconcile-v3",outcome:"observed_matching|unresolved",decision:<read DTO>,consistency:"observed_only_non_atomic"}`.
Это только SELECT: проверяет requestId/hash/revision/state/group/source и согласование
двух наблюдений. `unresolved`/404/503 не доказывает отсутствие записи; сначала явное
чтение, новое подтверждение актуальных фактов/revision, затем новый requestId.

`status`: `unreviewed|approved|explicit_unclassified|cleared|stale`.
`groupId` — только эффективная approved группа; `storedGroupId` и `group` сохраняют
историю stale решения. Архивирование группы само не делает прежнее решение stale:
оно сохраняется в истории/статистике, но новые назначения запрещены.

### Правила и предпросмотр

| Метод / путь | DTO |
|---|---|
| GET `/rules` | `result:{rules:[...]}`; legacy и v3 вместе, max5000, overflow503 |
| POST `/rules` | `{"dataset":"expenses","category":" Транспорт ","title":" Ремонт ","groupId":"...","enabled":true}` |
| POST `/rules` | `{"dataset":"incomes","source":" Зарплата ","groupId":"..."}` |
| PATCH `/rules/:id` | `{"expectedEtag":"<64 hex>","enabled":false}`; dataset immutable, `title:null` снимает специфичность |
| DELETE `/rules/:id` | `{"expectedEtag":"<64 hex>"}` → `result:{deleted:true}` |

Rule result включает `id,dataset,enabled,category/title|source,groupId,group,etag,revision,diagnostic,createdAt,updatedAt`.
`diagnostic`: `ready|disabled|group_missing|group_inactive`. Строки сравниваются
`trim().toLowerCase()`; category+title приоритетнее category, disabled rule игнорируется.
Недоступная группа у специфичного правила диагностируется, а не подменяется более
общим правилом. Rename не меняет target. Неактивную группу назначить правилу нельзя;
сохранившееся правило с архивной группой видно, его можно явно отключить, удалить или перенаправить; включить заново можно только с активной группой.
CAS по полному snapshot защищает также legacy правила; explicit PATCH переводит
только выбранное legacy правило в v3 с тем же `_id`. Seed не перезаписывает его.

```json
{"version":"classification-group-preview-v3","startInclusive":1735689600000,"endExclusive":1738368000000,"operations":[{"dataset":"expenses","operationId":"111111111111111111111111"}]}
```

POST `/preview` возвращает `result:{version,window,proposals,consistency}`;
каждый proposal: dataset/operationId, expectedFacts/expectedRevision, sourceStatus,
`eligible` и `match:{ruleId,ruleEtag,groupId,diagnostic}|null`. Eligible только unreviewed
+ready. 1–100 разных identities, все owner-scoped, внутри периода. Это не write permit:
последующее явное подтверждение использует обычный single-operation PUT с CAS.
Пакетный frontend должен показывать выбранные предложения, сохранять их отдельно,
останавливаться/сообщать conflicts/unknown; backend не запускает batch автоматически.

### Group-aware отчёт

POST `/report`:

```json
{"version":"classification-group-report-v3","startInclusive":1735689600000,"endExclusive":1738368000000,"includeOperations":true,"dataset":"expenses","groupId":"custom:10000000-0000-4000-8000-000000000001"}
```

UTC `[startInclusive,endExclusive)`, ≤366 суток, integer epoch ms; dataset/groupId
optional. `groupId:null` выбирает неклассифицированные строки. Ответ `result`:
`version,window,totals:{expenses,incomes},groups,operations,coverage,filtered,consistency`.
В totals: `{kopecks,signedKopecks,count}`; в group bucket:
`{dataset,groupId|null,name|null,status|null,kopecks,signedKopecks,count}`.
`operations` — read DTO с `kopecks,signedKopecks`.

**Фильтры ограничивают только возвращаемые operations**; totals/groups всегда
охватывают весь проверенный период обоих datasets и явно сверяются между собой.
`includeOperations:false` (default) не возвращает operation payloads. Stale,
explicit_unclassified, cleared и unreviewed входят в unclassified bucket. Archived
approved входит в собственную группу. Возврат займа/покупки/капитала всегда income+;
выдача займа/инвестиции всегда expense−. Старые финансовые итоги не заменяются.

Никакого округления: десятичное roundtrip представление исходного binary64 должно
точно выражаться в копейках (≤2 знаков), суммы — safe integer через BigInt checks;
иначе503 `unsupported_precision|amount_overflow`. Полнота — два сравниваемых обхода
исходных membership/facts, source limit50000, batched decisions/groups по500.
Нет скрытой пагинации/усечения; >1000 отфильтрованных operations —503
`operation_response_limit` (можно запросить summary или меньший период).
Общий ответ ≤3.5MB. `coverage:"complete_recorded_period"` означает все записанные
источники наблюдённого периода, а не все возможные recurrence/плановые события.

## Ограничения консистентности

На standalone MongoDB нет общей транзакции expense PATCH/DELETE + classification
+group/rule metadata. Проверки сужают race window, но не устраняют его; все DTO явно
`observed_only_non_atomic`. Изменение источника даёт stale; concurrent DELETE или
group archive после write может дать503/unknown при уже сохранённой записи.
Reconcile только наблюдает. Несколько чтений metadata/decisions в отчёте не являются
snapshot-транзакцией; два source обхода не доказывают отсутствие A→B→A истории.
Fingerprint — hash фактов, не privacy encryption и не монотонная source revision.
Архивные ссылки никогда не удаляются автоматически. TTL для решений не вводится.

## Безопасная миграция (подготовлена, в пользовательской БД не выполнялась)

Порядок будущего **отдельно согласованного** локального запуска:

1. Совместимый backend + обновлённый frontend подготовлены, новый gate выключен.
   Остановить пользовательские изменения metadata/классификаций на время миграции.
2. Установить точное application DB name, сервер/version/FCV. Сделать проверенный
   зашифрованный backup БД и сохранить отдельно `listCollections` options/indexes;
   предварительно проверить restore в disposable MongoDB.
3. `npm ci`, `npm run typecheck`, `npm run build`. Настроить **только отдельную**
   `CLASSIFICATION_GROUP_MIGRATION_URI` непосредственно в локальном терминале,
   не в команде истории/чате и не через application dotenv. URI допускает только
   loopback `mongodb://`, без DB path/query/hash; DB задаётся отдельно.
4. Выполнить dry-run, проверить counts/plan и отсутствие error. Команды ниже
   предполагают, что переменные уже безопасно заданы владельцем:

```sh
node dist/scripts/migrateClassificationGroups.js --db "$BUDGET_MIGRATION_DB_NAME" --environment local --dry-run
node dist/scripts/migrateClassificationGroups.js --db "$BUDGET_MIGRATION_DB_NAME" --environment local --confirm-write --backup-confirmed
node dist/scripts/migrateClassificationGroups.js --db "$BUDGET_MIGRATION_DB_NAME" --environment local --verify
```

Нет автоматического чтения `.env`, fallback на DATA_BASE_URL, распечатки URI или
raw ошибок. Доступные environment: local/test, имя БД обязательно и сверяется с
активным; admin/config/local запрещены. Test name только guard-generated
`budget_ownership_it_<32hex>`. Этот инструмент не доказывает disposable характер
произвольного локального сервера: локальный URI/DB/backup проверяет владелец.

Dry-run/verify читают **только classification metadata и каталоги**, без financial
records и без записей/DDL. Preflight проверяет **все** коллекции до DDL, документы,
ссылки, индексы/options, известный exact старый validator. Несовместимые/missing
индексы существующей коллекции, неожиданные validators/документы — STOP, без repair.
Apply создаёт только отсутствующие коллекции с manifest/indexes либо делает collMod
из точно известного старого validator. Не syncIndexes, не drop/recreate и не backfill.
После apply повторная exact verification обязательна. Успешный повторный apply —
no-op; частично созданная коллекция без полного индекса fail-closed и требует
разбора владельцем, не автоматического удаления или ослабления readiness.

5. Проверить verify, прежние read API, totals и source integrity. Только отдельным
   решением включить flags и явно инициализировать system catalog через API.
6. Rollback до первых v3 назначений/правил: выключить новый gate и writes, затем:

```sh
node dist/scripts/migrateClassificationGroups.js --db "$BUDGET_MIGRATION_DB_NAME" --environment local --rollback --backup-confirmed
```

Rollback блокируется, если хоть одно v3 решение/правило существует: нельзя скрыть
custom assignment старым validator. До v3 он возвращает прежний decision validator
и прежнее отсутствие rule validator (`{}`), **сохраняет каталог и индексы**.
Каталог не удаляется даже если пуст/не используется. После появления v3 безопасный
rollback — gate off с текущим reader, либо отдельный проверенный restore backup
с согласованием потери последующих изменений; не автоматическая обратная конверсия.

## Проверки

`tests/classification-groups.test.cjs` — pure identities/normalization, strict BSON,
Mongoose no-cast/no-DDL model, priority, dates, CLI guards, без DB подключения.
`tests/classification-groups.integration.test.cjs` — настоящий compiled app/JWT/native
MongoDB, A/B isolation, CRUD/CAS, source edits/deletes, unknown+reconcile, legacy,
8 seed rules, preview без writes, signed report, Mongo validators/readiness,
dry-run command monitoring, apply/repeat/verify/rollback. Уникальная test-only БД
через существующий harness; drop/empty/connection/listener/logs cleanup обязателен.
Оба файла включены в существующие npm/CI runners; parent failures не игнорируются.
