# RFC C1 — индивидуальная финансовая классификация: модель хранения MongoDB

**Статус: PROPOSAL / docs-only. Не утверждает новую коллекцию, индекс, миграцию, публичный API, транзакции или доступ к production.**
**Контекст:** Budget Calculator, backend main \`b550ac8afc7164768507b35bece0c6a555a46929\`; согласовано продуктово: *каждая операция имеет свою классификацию; категория, наблюдаемая регулярность и экономическая роль/финансовый слой независимы; ручное решение приоритетнее рекомендации; подтверждения должны переживать перезапуск; правила для похожих будущих операций — отдельный этап*.

## 1. Установленные технические факты

- \`models/expense.js\`: \`_id:ObjectId\`, \`owner:ObjectId\`, \`amount:Number\`, \`date:Date\`, \`category/title/recipient:String\`, \`comment?\`, timestamps, Mongoose \`__v\`.
- \`models/income.js\`: \`_id:ObjectId\`, \`owner:ObjectId\`, \`amount:Number\`, \`date:Date\`, \`source:String\`, \`comment?\`, timestamps, Mongoose \`__v\`.
- Текущие PATCH используют \`findOneAndUpdate()\`; стандартный Mongoose \`__v\` **не является** гарантированным счётчиком всех таких обновлений. \`updatedAt\` также не является достаточным CAS при гонках.
- \`domain/recurrence.ts\` и \`GET /analytics/recurrence\` формируют **наблюдения**, без назначения роли/слоя и без сохранения классификации. \`coverage.historicalContinuity\` остаётся \`unverified\`.
- Frontend \`FINANCIAL_LAYERS\`: \`everyday\`, \`irregular\`, \`emergency\`, \`major_goals\`, \`long_term_capital\`. Роли: \`unknown\`, \`ordinary_expense\`, \`ordinary_income\`, \`loan_issuance\`, \`loan_repayment\`, \`refund\`, \`internal_transfer\`, \`capital_movement\`. Версия \`financial-layers-v1-provisional\` **пока не постоянный серверный контракт**.
- Frontend \`caller_local\` revision — жизненный цикл локального draft, **не** серверный revision и **не** токен конкуренции.
- У существующих категорий расходов в финансовых документах хранится строка; одинаковая подпись системной и пользовательской категории не доказывает один category ID.
- Не подтверждено, что production MongoDB доступен как replica set; существующая изолированная интеграционная БД использует standalone MongoDB.

## 2. Решение: классификация операции — отдельная необязательная запись

Рекомендуемая новая коллекция (только предложение): \`operation_classifications\`.

Каждая финансовая операция логически имеет состояние \`unreviewed/unknown\` по умолчанию. **Не создавать по записи классификации на каждую старую операцию**: запись в коллекции появляется только после явного решения пользователя (или отдельного согласованного будущего действия).

Связка — \`(owner, dataset, operationId)\`. Одинаковый \`operationId\` у income и expense не пересекается; совпадение строк категории не влияет на identity. Первичный ключ новой записи — самостоятельный \`_id\`.

### 2.1. Кандидатная структура

\`\`\`ts
type OperationClassificationRecord = {
  _id: ObjectId;
  owner: ObjectId;                      // ONLY server verified JWT principal
  dataset: 'expenses' | 'incomes';      // source collection, not inferred from ID
  operationId: ObjectId;               // original expense._id or income._id
  state: 'approved' | 'explicit_unclassified' | 'cleared';
  assignment?: {
    economicRole: Exclude<EconomicRole, 'unknown'>;
    layer: FinancialLayer | null;
  };
  decisionOrigin: 'manual';            // v1 ONLY; no auto-approval
  taxonomyVersion: string;             // explicit supported version, not arbitrary
  sourceFingerprint: string;           // server-generated opaque canonical source fact hash
  sourceFingerprintVersion: number;
  decisionRevision: number;            // monotonic, server-owned CAS; >=1
  createdAt: Date;
  updatedAt: Date;
};
\`\`\`

**Строгие инварианты:**
- \`approved\`: обязательно \`assignment\`; \`economicRole=ordinary_expense\` допускает финансовый слой; прочие роли допускают только \`layer:null\`. Точную матрицу **dataset ↔ economicRole** утвердить до implementation, не принимать произвольную роль от клиента.
- \`explicit_unclassified\`: \`assignment\` отсутствует, блокирует будущие авто-рекомендации для данной операции.
- \`cleared\`: \`assignment\` отсутствует; означает «ручное решение сброшено», вновь разрешает правила/автопредложения; документ оставлен для сохранения \`decisionRevision\` и устранения ABA после удаления/повторного создания.
- Если записи нет: \`unreviewed\`. В отчётах \`cleared\` тоже не является подтверждённой классификацией; не путать с \`explicit_unclassified\`.
- \`decisionRevision\` не равен \`__v\`, \`updatedAt\`, session epoch или frontend \`loadGeneration\`; клиент не может сам его устанавливать.
- Не записывать сюда полные суммы, комментарии, title/recipient, category или JWT. Финансовые факты читаются из оригинала при авторизованном запросе. \`sourceFingerprint\` не считается финансовой суммой, недоступен как источник авторизации, не логируется.
- Системная/пользовательская категория пока имеет лишь label-only provenance; не вводить несуществующие dictionary FK.
- Серверные DTO экспонируют только безопасные поля и явную актуальность решения; не возвращать произвольный MongoDB-объект.

### 2.2. Индекс (только после согласования)

\`db.operation_classifications.createIndex({ owner: 1, dataset: 1, operationId: 1 }, { unique: true, name: 'ux_owner_dataset_operation' })\`

Гарантирует не более **одной текущей записи** на операцию владельца; начальная вставка ловит duplicate key, не выполняет неиндексированный upsert. Индексы для истории/правил/сортировок добавлять только по измеренным запросам. Сами коллекция и индекс являются изменением DB; никакого скрытого \`autoIndex\` при запуске.

## 3. Актуальность исходной операции и concurrency

### 3.1. Токен исходного факта

Перед выдачей ручной формы сервер получает исходную операцию **в фильтре \`{_id, owner}\`**, валидирует документ и вычисляет непрозрачный \`sourceFingerprint\` из *канонической версии* всех review-значимых фактов: dataset/ID/owner, Date UTC, сумма без округления, category/title/recipient либо source, comment/null/absence; фиксирует \`sourceFingerprintVersion\`. Ни Date-string locale, ни сравнение JS объектов, ни \`__v\` отдельно не подходят.

При сохранении требуется явно предъявить ожидаемый source token; backend повторно проверяет исходную операцию и вычисляет токен заново. Старый token → \`409 conflict/stale_source\` без сохранения. Сверка токена — **проверка фактов**, не доказательство уникальной версии каждого промежуточного обновления: изменение A→B→A или правка в момент записи требует отдельной политики source revision. Точное включение необязательных полей/алгоритм сериализации/секретность hash должны быть утверждены до API.

### 3.2. CAS отдельной классификации

Запись \`approved/explicit_unclassified/cleared\` обновляется атомарно по фильтру \`{owner,dataset,operationId,decisionRevision: expectedRevision}\`, с \`$inc: {decisionRevision:1}\`. Для отсутствующей классификации разрешён только \`expectedRevision: null\` и однократный insert; unique index предотвращает две одновременные вставки. Проигравший клиент получает \`409\`, а не молчаливую перезапись. \`cleared\` не удаляет revision. Дубли запроса требуют отдельной idempotency-политики: повторный успешный запрос не должен снова увеличивать revision из-за network retry.

Это защищает **решения между собой**, но **не сериализует** проверку source и запись в другую коллекцию.

### 3.3. Важный нерешённый race с PATCH/DELETE финансовой операции

Сейчас expense/income PATCH/DELETE **не участвуют** в общем source-revision/transaction protocol. Поэтому проверка source непосредственно перед CAS классификации не защищает от параллельного PATCH/DELETE, случившегося между ними.

Возможности:
1. **Фазовая conservative consistency (минимальный объём):** сохранять CAS classification и source hash; при каждом чтении заново проверять owner/source existence/fingerprint, выдавать \`stale\`/orphan без подтверждённой классификации. Это уменьшает риск неправильного отображения, **но не гарантирует** отсутствие момента устаревшей записи. Нельзя рекламировать strict concurrency; обязательны тесты read-after-race и UI blocked/stale.
2. **Строгая межколлекционная согласованность:** согласованный source revision, включение текущих финансовых PATCH/DELETE в протокол блокировки/изменения ревизии и MongoDB transaction; требует отдельного архитектурного согласия, проверенного replica set, производственных тестов и миграционного плана. Не делать в классификационном PR исподтишка.
3. **Новые поля прямо в expense/income:** упрощают CAS на источнике, но затрагивают публичные модели/миграцию — отвергаем для первого этапа.

**Вопрос на утверждение перед write API:** допускается ли консервативный вариант 1 со \`stale\` и явной ограниченной гарантией либо требуется вариант 2 до первого сохранения?

## 4. Чтение и политика приоритетов

Read classification **всегда** устанавливает owner из авторизации и сверяет каждую ссылку с существующей source-операцией того же owner. Даже корректно подделанный operationId другого пользователя не даёт права на чтение/изменение.

Приоритет на уровне \`(owner,dataset,operationId)\`:
1. \`approved\` + актуальный source token → подтверждено вручную.
2. \`explicit_unclassified\` + актуальный token → пользователь явно отказался от классификации; правила/auto не заменяют.
3. \`cleared\` или нет записи → в будущем допускается предложение правил, но не подтверждение.
4. Устаревший token, удалённый source, неизвестная версия taxonomy или нарушение инварианта → \`stale/blocked\` и **не включать в подтверждённые финансовые суммы** до повторной проверки.

Повторяемость по категории/похожей операции — отдельные *observations*, не \`assignment\`; не допускать «бензин регулярный → автоматически everyday» без подтверждённой экономической роли и согласованных критериев.

## 5. Правила — отдельная фаза

Кандидатная будущая коллекция \`classification_rules\` (НЕ в первой миграции):
\`owner, dataset, enabled, matchVersion, exactSelectors(category provenance/label, title, recipient | income source), proposedAssignment, priority, ruleRevision, createdAt, updatedAt\`.

- Правило означает «**предложить** похожим операциям», а не сохранять массово в \`operation_classifications\`.
- Условие категории не смешивает verified dictionary ID с label-only. Источник дохода не доказывает конкретного плательщика.
- Сначала отдельный UX review: показать сколько записей затронет правило, примеры и конфликтующие правила, получить явное согласие.
- Групповое редактирование прошлых операций — другой API, с preview count, bounded write, идемпотентностью и откатом.
- Автонаблюдения \`/analytics/recurrence\` не становятся сами по себе правилами.
- Нормализация названий (case-folding, Unicode, пробелы), precedence и идентичность категорий ещё OPEN.

## 6. Audit, удаление, приватность

V1 с одной текущей записью хранит \`createdAt/updatedAt/decisionRevision\`, но **не полную неизменяемую историю всех правок**. Если требуется полноценный аудит, предложить \`classification_decision_events\` как append-only журнал в одной транзакции с CAS и проверить доступность replica set; standby MongoDB не гарантирует многодокументную атомарность. Не писать события «best effort» и не выдавать их за полный аудит.

При удалении исходной операции classification остаётся физически возможным orphan. Read не должен публиковать orphan; дальнейшую очистку/retention, восстановление из backup, удаление аккаунта и право на удаление данных утвердить отдельно. Никаких скрытых каскадных удалений в текущих контроллерах.

Нет реальных данных в тестах, console/файловых логах и внешних сервисах. Не сохранять токены, оригинальные финансовые поля или email в classification documents. Разрешение доступа всегда только server owner check.

## 7. План развёртывания и отката

**P0 (этот PR):** только RFC; без runtime изменений.

**P1 — после утверждения schema/index:** модель + runtime validators + isolated pure tests, **без маршрутов и автоматического создания индекса в production**. Документированный одноразовый, ограниченный по окружению migration/index plan, безопасный dry-run, backup и список индексов; новую коллекцию сначала создают пустой. Старые expense/income документы НЕ перезаписываются (нулевой backfill). Проверка на отдельной тестовой MongoDB и проверка владельца.

**P2 — read model/API:** безопасная проекция решений только owner, \`unreviewed/stale\` статусы, проверка исходного документа. Контрактный и реальный MongoDB owner isolation.

**P3 — write API:** явный confirmation, \`expectedRevision\`, source fingerprint, create/CAS/cleared, 409, duplicate requests, cross-owner, delete race, authoritative validation. Выбор consistency policy раздела 3 — блокирующее решение.

**P4 — frontend:** \`useVerifiedOwner\`, RTK Query session boundary, safe drafts, явная ручная проверка, конфликтное состояние не закрывает форму, нет чужого cache; существующие analytics totals неизменны.

**P5 — rules / audit:** отдельные RFC и approval для индексной нагрузки, транзакций и нормализации.

**Rollback:** до включения P3 feature flag/routes можно убрать без удаления данных; после записи решения **не удалять коллекцию при rollback**. Версии taxonomy и schema сохранять читаемыми либо мигрировать только согласованным forward-only способом.

## 8. Обязательные проверки реализации

- Разные operations в одной category и разные financial layers (бензин vs ремонт); один operationId в incomes+expenses.
- A/B владельцы, A→B→A и повторный вход одного owner; no token/invalid token.
- approved vs explicit_unclassified vs cleared vs unreviewed и ручной приоритет.
- Два конкурентных PATCH классификации: только один CAS success, другой 409; параллельные initial inserts с unique index.
- Старый source fingerprint/правка даты, суммы, комментария/категории и deletion source → stale, никакой чужой документ не читается.
- Удалённая/отсутствующая операция, невалидные ObjectId, незнакомые версии taxonomy и role/dataset conflicts.
- Запрещены prototype/$ операторы в input; никакой raw update или owner из body.
- Ни одна классификация не меняет income/expense BSON; нет double count в аналитике.
- Миграция нулевого backfill и откат без потери ручных решений.

## 9. Решения, требующие явного согласования

1. \`operation_classifications\` + уникальный \`(owner,dataset,operationId)\`; \`state=approved|explicit_unclassified|cleared\`; versioned CAS.
2. Матрица \`economicRole × dataset × layer\` и серверная версия таксономии.
3. Политика source concurrency (conservative stale vs strict transaction/source revision).
4. Нужна ли полная append-only audit history уже в первом write-release.
5. Future rules: только предложения или явное пользовательское массовое применение; нормализация и приоритет.
6. Политика orphan/retention, тестовой/production MongoDB topology, migration/backup.

**До этих решений PR не позволяет создавать коллекцию, индекс, модель, live endpoints или миграции.**
