# RFC C2.2 — индивидуальная классификация: persistence и план миграции

**Статус: PROPOSAL / docs-only; каждое новое техническое решение ожидает owner approval.**
Обновление существующего Draft [PR #17](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/pull/17).
Ни этот документ, ни его merge не разрешают реализацию, миграцию, deployment или доступ к production.
Ниже «требуется» описывает условия предлагаемого будущего решения, а не текущую авторизацию.

## 1. Основания и границы согласования

### Уже согласовано продуктово

- Классификация относится к отдельной операции `(owner, dataset, operationId)`, независимо от категории.
- Категория, recurrence observations, экономическая роль и финансовый слой — разные понятия.
- Ручное решение приоритетнее рекомендации; предложение не является одобрением.
- Будущее хранение — отдельно от существующих expense/income; исходные документы не меняются.
- Правила, автоматизация и массовое применение — отдельные этапы.

### Проверенные факты репозитория

Проверен backend `main` **`8d73d0524d83b316adba5fd6dd576971f64fc441`**, включая merged PR #18:

| Источник | Установленный факт |
| --- | --- |
| `domain/classification.ts`, README и 40 domain contracts | Чистый структурный контракт; `approved/explicit_unclassified/cleared`, origin `manual`, positive safe integer revision; только `financial-layers-v1-provisional`. Нет persistence, fingerprint или dataset/role policy. |
| `models/expense.js` | ObjectId `_id/owner`, Number `amount >= 0`, Date `date`, обязательные `category/title/recipient`, необязательный `comment`, timestamps и `__v`. String trim уже выполняется моделью. |
| `models/income.js` | ObjectId `_id/owner`, Number `amount >= 0`, Date `date`, обязательный `source`, необязательный `comment`, timestamps и `__v`. |
| `controllers/expenses.js`, `controllers/incomes.js` | PATCH: `findOneAndUpdate({_id, owner}, selectedFields, {new:true, runValidators:true})`; DELETE: `findOneAndDelete({_id, owner})`. Нет общего source revision, classification CAS, session или transaction. |
| `domain/recurrence.ts`, `controllers/recurrence.ts` | Наблюдения, не решения о классификации; движок не меняется. |
| `package-lock.json`, `tsconfig.json`, CI | Mongoose 8.24.1, MongoDB driver 6.20.0, BSON 6.10.4; strict TypeScript/CommonJS, authoritative CI Node.js 22. |
| `.github/workflows/ci.yml`, `tests/helpers/mongodb-integration.cjs` | Изолированный MongoDB 7.0.45, закреплённый digest, loopback/tmpfs, без `--replSet`; существующие тесты не устанавливают transaction/replica-set readiness. Helper генерирует одноразовый DB name и закрывает/удаляет только свою БД. |
| Frontend `model/types.ts`, `classification.ts`, `reviewSession.ts` | Provisional vocabulary/matrix; frontend revision `caller_local` не серверный CAS. Проверены реальные файлы frontend commit `6d4f30f03e3958be758afcdd7ebbcbfab77e9be4`, read-only. |

Production MongoDB version, topology, sharding, privileges, backups и transaction support — **UNVERIFIED**.
Проверки репозитория не являются проверкой живого сервера. Базы данных не открывались.
`__v` при текущих PATCH не является гарантированным счётчиком каждой правки; `updatedAt` не CAS.

## 2. Точный кандидат документа и граница C2.1

Предлагается одна текущая запись в **`operation_classifications`** после явного ручного решения.
Отсутствие записи — `unreviewed`, без фиктивного default document и без backfill старых операций.
Это не Mongoose model и не публичный DTO. Все поля обязательны, кроме условного `assignment`.

| Поле | Предлагаемый BSON / ограничения | Семантика |
| --- | --- | --- |
| `_id` | ObjectId, immutable, server-generated | Самостоятельный ID решения. |
| `owner` | ObjectId, immutable, non-null | Только authenticated server principal; не из тела запроса. |
| `dataset` | String enum `expenses/incomes`, immutable | Выбор исходной коллекции; не выводится из ID. |
| `operationId` | ObjectId, immutable, non-null | Ссылка на конкретную source operation того же owner. |
| `state` | String enum `approved/explicit_unclassified/cleared` | Только эти persisted states. |
| `assignment` | Single nested object, без собственного `_id`, без default | Обязателен только у `approved`; иначе поле полностью отсутствует. |
| `assignment.economicRole` | String enum семи ролей из §3 | `unknown` запрещён. |
| `assignment.layer` | Один из пяти layer codes либо явный BSON null | У `ordinary_expense` один supported layer; у остальных строго null. Поле не отсутствует внутри assignment. |
| `taxonomyVersion` | Exact registered String, non-null, без default | Первый стабильный кандидат: `financial-classification-v1`, только после утверждения §3. |
| `decisionOrigin` | String literal `manual`, non-null | Никаких `automatic/category_rule`; устанавливает сервер после явного действия. |
| `decisionRevision` | BSON int/long/double; математически целое `1..9007199254740991` | Серверный monotonic CAS только решений; в JS только safe integer. Не Decimal128/string. |
| `sourceFingerprint` | String, ровно 64 lowercase hex | SHA-256 по каноническому source tuple §4, не исходные финансовые поля. |
| `sourceFingerprintVersion` | Numeric integer literal `1` | Версия канонизации и алгоритма, не taxonomy/recurrence version. |
| `sourceObservedAt` | BSON Date, valid, server-owned | Момент завершения source read; не доказательство отсутствия гонки. |
| `lastMutation` | Required nested object, без `_id` | Ограниченная дедупликация последней команды, §5. |
| `lastMutation.requestId` | String canonical lowercase UUID v4, ровно 36 chars | Future client command ID, не JWT и не доказательство доступа. |
| `lastMutation.commandFingerprint` | String, ровно 64 lowercase hex | Digest канонического намерения команды; raw payload не сохраняется. |
| `lastMutation.commandFingerprintVersion` | Numeric integer literal `1` | Отдельная версия формата команды. |
| `createdAt/updatedAt` | Required BSON Date; `createdAt <= updatedAt` | Серверные timestamps; createdAt сохраняется при CAS. Не source revision. |

Полный набор полей закрыт, в том числе внутри assignment/lastMutation. Null не заменяет отсутствие
assignment: `assignment:null` невалиден при любом state. Нет implicit trim, enum coercion,
default layer, default state или default taxonomy. Нет сумм, дат операции, category, title,
recipient, source label, comment, email, headers, JWT или свободных error metadata.
`sourceObservedAt` — operational timestamp, не копия source date.

### 2.1. Предлагаемые Mongoose и DB constraints

- Существующий CommonJS/incremental TS сохраняется. Будущая schema: `strict:'throw'`,
  `strictQuery:'throw'`, `versionKey:false`, `autoCreate:false`, `autoIndex:false`.
  Обычный Mongoose cast не считается boundary validation: валидировать unknown до casting,
  иначе Number/String/ObjectId могут скрыто принять чужой тип.
- ObjectId: сначала ровно 24 ASCII hex chars без trim, затем явный BSON conversion.
  C2.1 сохраняет регистр; persistence adapter сравнивает BSON identity и использует lowercase
  `toHexString()` только в fingerprint. Это отдельное представление, не изменение C2.1.
  Существование source и owner проверяется отдельным owner-scoped read, не `ref`/populate.
- Assignment: document-level проверка state/role/layer и утверждённой матрицы. Для nullable
  layer нужен собственный валидатор присутствия: простой `required:true` String отвергает null.
  У non-approved при записи выполняется явное удаление assignment, а не `$set:undefined`.
- `Number.isSafeInteger` и границы revision проверяются до записи/после чтения; при max revision
  обновление отвергается, не wrap/reset. BSON long допускается только при точном safe-number
  round-trip. `runValidators:true` на update не заменяет проверку полного candidate document;
  `$inc` и поля, не участвующие в update, не дают полной document validation в Mongoose.
- Перед каждым CAS сервер строит полный prospective document, валидирует его целиком и лишь
  затем строит собственный ограниченный update. Клиентские Mongo operators/filters/replacement
  не принимаются. Timestamp handling явно покрывается тестами; auto timestamps не должны
  сбрасывать createdAt при replace/upsert. Счётчик не подменяется `optimisticConcurrency/__v`.
- После отдельного approval миграция ставит collection validator (`validationLevel:strict`,
  `validationAction:error`): закрытая `$jsonSchema`, required/enum/BSON type/range/integer
  constraints и условие state/assignment/role/layer. `_id` явно разрешён. Применимость точного
  выражения и обходные DB privileges проверяются в отдельном implementation PR на целевой
  MongoDB версии. DB validator не доказывает ownership, manual confirmation или CAS.

**Индекс-кандидат:** встроенный unique `_id` плюс ровно один дополнительный индекс
`ux_owner_dataset_operation`: keys **`{owner:1, dataset:1, operationId:1}`**, `unique:true`,
`sparse:false`, без partial filter/TTL, simple collation. Все три поля required/non-null;
регистр String ID не создаёт дубликат, поскольку в БД хранятся ObjectId.
Индекс ограничивает одну текущую запись во всех states, включая cleared. Это не foreign key
и не history storage. Других индексов без измеренных запросов не предлагается.
Первоначальный план только для unsharded collection; sharding требует отдельного review
уникальности и shard key. При отсутствии/несовпадении индекса writes остаются выключенными.

### 2.2. Соответствие C2.1 — без скрытой смены контракта

C2.1 принимает плоские owner/dataset/operationId, state, assignment, manual origin,
revision и **только provisional taxonomy**, отвергает все storage fields. Поэтому BSON документ
нельзя передавать прямо в `validateClassificationDecision`: нужен будущий явный adapter,
который проверит envelope, преобразует ObjectId, выделит domain projection, затем применит
версионный validator и business policy. Нельзя молча удалить неизвестную taxonomy ради успешной проверки.

Стабильная `financial-classification-v1` сейчас **отвергается C2.1**. До первых durable writes
нужен отдельно одобренный переход domain validator/version registry, explicit frontend mapping,
тесты обеих поддерживаемых версий. Provisional не переименовывается и не объявляется
эквивалентной стабильной; в первой persistent collection provisional records не предлагаются.
В этом PR C2.1, его README и тесты не меняются.

## 3. Матрица dataset ↔ economic role и taxonomy

Все строки ниже — **backend proposal awaiting product approval**, даже если совпадают с UI.
Layer-инвариант уже реализован C2.1; dataset mapping там сознательно отсутствует.

| Economic role | Предлагаемые datasets | Layer | Пример / ограничение | Статус mapping |
| --- | --- | --- | --- | --- |
| `ordinary_expense` | expenses | Ровно один из пяти | Бензин everyday, ремонт irregular в одной категории «Транспорт». | Совпадает с frontend; отдельное backend approval ещё требуется. |
| `ordinary_income` | incomes | Только null | Зарплата/оплата труда, не заём/перевод/возврат капитала. | Совпадает с frontend; approval требуется. |
| `loan_issuance` | expenses | Только null | Пользователь выдал основную сумму займа другому лицу. Полученный пользователем заём этим кодом не покрывается. | Frontend так же; терминология/объём требуют product approval. |
| `loan_repayment` | incomes | Только null | Пользователю вернули основную сумму ранее выданного займа. Погашение собственного долга и проценты не охвачены этой трактовкой. | Frontend так же; principal/interest и направление требуют approval. |
| `refund` | incomes | Только null | Возврат покупки продавцом. Не отрицательный расход; не earned income. Исходящие возвраты не покрыты. | Frontend так же; значение и влияние на будущие отчёты требуют approval. |
| `internal_transfer` | expenses и incomes | Только null | Исходящая/входящая сторона перемещения между своими счетами. | Frontend разрешает обе; определение собственных счетов/парности требует approval. |
| `capital_movement` | expenses и incomes | Только null | Покупка/продажа инвестиционного principal без утверждения earned income/consumption. | Frontend разрешает обе; principal/gain/fee decomposition требует approval. |

Пять layers: `everyday`, `irregular`, `emergency`, `major_goals`, `long_term_capital`.
Последний — слой одобренного ordinary expense, не синоним capital_movement.
Классификация не меняет знак/сумму исходного документа, старый balance или аналитику.
Transfer без account IDs и связанной пары пока только ручная метка: нельзя автоматически
net/dedupe/count counterpart, доказывать «свои счета» или вычислять новые итоги.
Непокрытые входящие займы, собственные выплаты долга, проценты, комиссии и исходящие refunds
остаются explicit_unclassified/unreviewed до отдельного расширения; не втискивать их в ordinary roles.

**Version strategy (proposal):** immutable registry по exact string; стабильная v1 только после
утверждения meanings/matrix/layers. Любая смена допустимости/смысла — новая semantic version
контракта (`financial-classification-v2`), без переинтерпретации старых решений. Добавление
нового code тоже требует явно поддержанной версии; readers должны знать mapping или fail closed.
Unknown/retired/несопоставимая версия → blocked, не confirmed; upgrade записи только через
отдельно утверждённый mapping либо ручное повторное подтверждение с новой revision.
Fingerprint, storage evolution, command digest и taxonomy version независимы; silent defaults нет.

## 4. Canonical source fingerprint v1 (предложение)

Цель — обнаруживать изменение **прочитанных review-значимых значений**, а не доказать отсутствие
всех промежуточных правок. SHA-256 реализуем штатным `node:crypto`, без новой зависимости.
Digest не анонимизирует финансовые данные и не является authorization/signature. Не логировать
его или canonical bytes, не включать в metric labels; доступ как к приватному финансовому metadata.
HMAC-SHA-256 лучше защищает от offline guessing при утечке digest, но требует key ID, secret
management, rotation и стратегии reread старых ключей. Для первого варианта рекомендуем обычный
SHA-256 при закрытом хранении и явном принятии этого риска; выбор требует owner approval.

**Точная предлагаемая канонизация:** fixed-order JSON tuple, UTF-8 bytes от ECMAScript
`JSON.stringify`, без locale и object-key sorting. Никаких raw BSON/Mongoose `toJSON` hooks:
адаптер явно извлекает поля и проверяет типы. Два разных префикса исключают reuse как command hash.

- Префикс `budget-classification-source`, числовая версия `1`.
- Последовательно owner ObjectId lowercase hex, dataset literal, operationId lowercase hex.
- Затем именованные tagged slots в фиксированном порядке: `amount`, `date`, для expenses
  `category,title,recipient,comment`; для incomes `source,comment`.
- Required amount — конечное Number `>=0`, без coercion, округления/копеек/decimal conversion;
  tag `number64` + ровно 16 hex chars IEEE-754 binary64 big-endian bits. `-0` и `+0` различаются,
  если различимы в реально прочитанном значении. Reject NaN/Infinity и unsupported BSON numeric
  representations до lossy conversion; Decimal128/unsafe Long не переводить в Number.
- Date — valid BSON Date; tag `date-ms` + exact base-10 signed integer milliseconds UTC от epoch.
  Не календарная строка, не timezone/locale, не повторный parse UI date. Invalid date → blocked.
- String — tag `string` + exact stored Unicode string; не trim/case-fold/NFC. В моделях расхода
  trim уже выполнен до хранения: fingerprint берётся с persisted source, не с request body.
- Необязательный comment: отсутствие = tuple tag `absent`; explicit BSON null = `null`;
  пустая строка = `string` с пустым значением. Это три разных значения. Required fields при
  absent/null/type mismatch дают blocked, а не default. BSON undefined и неизвестные типы — blocked.
- `_id/owner` входят через identity; `createdAt`, `updatedAt`, `__v` не входят: это не source
  revision и не review facts. Неизвестные новые business fields блокируют поддержку новой формы
  до решения об их включении/новой версии; raw source snapshot не сохраняется в classification.

Нотация полного preimage (псевдоданные, не исполняемый алгоритм):

```text
expenses: ["budget-classification-source",1,ownerHex,"expenses",operationHex,
           ["amount",["number64",bitsHex]],["date",["date-ms",millisecondsText]],
           ["category",["string",category]],["title",["string",title]],
           ["recipient",["string",recipient]],["comment",commentValue]]
incomes:  ["budget-classification-source",1,ownerHex,"incomes",operationHex,
           ["amount",["number64",bitsHex]],["date",["date-ms",millisecondsText]],
           ["source",["string",source]],["comment",commentValue]]
commentValue: ["absent"] OR ["null"] OR ["string",exactStoredComment]
```

Пробелы/переносы выше только для чтения: hash получает compact JSON.stringify без pretty-print
и без завершающего newline. millisecondsText — canonical integer string без leading zero/plus
(для нуля `0`); bitsHex — lowercase. Это однозначный tuple format, не JSON произвольного объекта.

`sourceFingerprint` = lowercase hex SHA-256 этих bytes; `sourceFingerprintVersion=1`.
Текущие Number не становятся точными десятичными деньгами благодаря hash. Все решения о новой
money storage/precision вне scope. v2 читает запись по её явной версии; отсутствие поддержки
старой версии блокирует confirmed output до rereview/migration, не пересчитывает её молча.
`sourceObservedAt` хранит время наблюдения; не заменяет hash и не задаёт TTL/срок одобрения.

## 5. CAS, initial create и ограниченная идемпотентность

Предлагаемый будущий write flow, **без определения публичных маршрутов сейчас**:

1. Установить owner из principal; строго проверить dataset/ID и source read `{_id,owner}` в
   нужной коллекции. Чужой/удалённый/несуществующий source не раскрывается как чужая запись.
2. Проверить exact taxonomy, business matrix, целиком candidate state/assignment и ожидаемые
   decisionRevision + source fingerprint/version. Нельзя присвоить revision/timestamps из body.
3. Повторно прочитать source и пересчитать fingerprint; несовпадение ожидаемого токена означает
   конфликт без записи. Сравнение не разрешает переходить на новый source без нового review.
4. Initial create: только expectedRevision absent-record sentinel (предлагается явный null),
   сервер ставит revision=1. Только insert, не blind upsert. Unique tuple index оставляет одного
   победителя; E11000 распознаётся по этому индексу, затем owner-scoped reread и конфликт/дедупликация.
   Не любой duplicate-key считается успешным retry.
5. Existing record: atomic filter `{owner,dataset,operationId,decisionRevision:expectedRevision}`;
   server-built update устанавливает candidate/metadata, удаляет assignment при необходимости,
   увеличивает decisionRevision ровно на 1. matched=0 → conflict, не retry с новой revision.
   При успехе состояние read-only повторно оценивает freshness, §6. Даже same-value новая ручная
   команда увеличивает revision; cleared никогда не удаляет запись ради сброса счётчика.

**Дедупликация без второй коллекции (рекомендация awaiting approval):**
`lastMutation` записывается атомарно с initial insert/CAS. commandFingerprint — SHA-256 fixed-order
UTF-8 JSON tuple с отдельным префиксом `budget-classification-command`, version=1, canonical tuple
identity, requestId, expectedRevision, expected source fingerprint/version, taxonomy, manual origin,
целевой state и exact assignment (или отдельный absent tag). Значения проходили validation;
порядок полей исходного HTTP body не влияет. Operational timestamps не входят.

```text
["budget-classification-command",1,ownerHex,dataset,operationHex,requestId,
 expectedRevision,["source",sourceFingerprintVersion,sourceFingerprint],
 taxonomyVersion,"manual",state,assignmentValue]
assignmentValue: ["assignment",economicRole,layer] OR ["absent"]
```

expectedRevision — safe integer либо initial null; layer — enum string либо null по §3;
absent assignment допустим только в non-approved state. Encoding/compact JSON такие же, как §4.

При повторе последнего requestId + того же digest возвращается подтверждение уже применённой
revision без новой записи/инкремента; тот же ID + другое намерение → конфликт. Ответ заново
проверяет owner/source freshness: retry не восстанавливает старый «confirmed» snapshot и не
обещает byte-identical HTTP response. Source удалён → недоступно, source изменён → stale/blocked.
Сетевой timeout после commit разрешается reread по identity; не blind retry increment.

Это **ограниченная идемпотентность**, только пока команда последняя. После следующей команды
старый exact retry содержит старую expectedRevision и конфликтует (для initial — duplicate key),
но не применяется повторно. История всех requestId/вечный exact response replay не гарантируются;
повторное использование старого ID с новым намерением после его вытеснения не детектируется.
Если продукт требует durable dedupe на произвольный срок — нужен отдельный request ledger/event
storage в транзакции, новые retention/index decisions. Не объявлять этот вариант exactly-once.

## 6. Source race: сравнение и рекомендация

| Свойство | Option A — conservative detection | Option B — strict shared protocol |
| --- | --- | --- |
| Source documents / controllers | Без изменений, сохраняется текущий PATCH/DELETE. | Все writer paths должны участвовать в общем concurrency fence. Source revision в expense/income меняет документы и сейчас запрещена; sidecar fence — другой расширенный дизайн. |
| Decision concurrency | Atomic per-record CAS + unique tuple index. | То же внутри транзакции. |
| Source изменён до повторного read | Fingerprint mismatch → конфликт без записи. | Revision/fence mismatch → конфликт/abort. |
| PATCH/DELETE между read и classification CAS | Может сохраниться уже устаревшее решение; post-read может обнаружить, но не устраняет race. | Transaction должна **записывать/сериализовать source fence**, а не просто читать source snapshot; source PATCH/DELETE пишет тот же fence. Тогда конфликтующие writers не коммитятся независимо. |
| A→B→A | Одинаковые факты дают прежний hash; промежуточная правка не обнаруживается. | Monotonic source revision обнаруживает промежуточные изменения. |
| Последующие source edits | Read-time повторная проверка → stale; нет постоянного fresh-cache. | Даже после согласованного commit будущая правка может сделать решение stale; read-time validation всё ещё нужна. |
| Topology | Per-document atomicity, подходит standalone; production совместимость ещё проверяется. | Replica set либо supported sharded transaction topology, sessions, concerns, retry/abort и failover tests. Production readiness неизвестна; текущий standalone CI недостаточен. |
| Гарантия | Решение и показанные факты совпадают на момент наблюдения; нет общей linearizable snapshot/atomic source+decision guarantee. | Согласованность на точке commit только при полном участии **всех** writers и реальном write conflict/fence. Простого read transaction недостаточно при write skew. |

**Рекомендация awaiting owner approval: Option A для первого ограниченного release**: сохраняет
исходные модели/контроллеры, минимален для текущего стека. Это осознанный компромисс, а не
strict financial snapshot. Если недопустима даже временная stale запись/гонка в отображении,
первый write release блокируется до отдельно согласованного Option B, topology и изменения writer paths.

Read protocol A: после owner-scoped source read и decision read вычислить hash и проверить
state/shape/taxonomy/matrix/version. Удалённый source → не публиковать orphan/его assignment.
Mismatch → effective `stale`; malformed/unsupported → effective blocked, никогда confirmed.
Перед выдачей write success выполнить post-read; ошибка/unknown не считается fresh.
На каждом read заново; не считать timestamp или cached decision proof of freshness.
Даже два повторных read не исключают правку сразу после последнего: это явно допустимый риск A.
Агрегированные confirmed totals для согласованного source snapshot не вводятся этим RFC;
не добавлять классификацию в текущие финансовые итоги до отдельного reporting design.

## 7. Lifecycle и приоритет ручного решения

`stale/blocked` — **derived read conditions**, не новые persisted states C2.1.
Они сохраняют исходный state/revision, но отключают effective confirmed assignment.

| Состояние | Хранение / confirmed | Будущие рекомендации |
| --- | --- | --- |
| `unreviewed` | Записи нет; confirmed нет. | Можно предложить, никогда auto-approve. |
| `approved` и проверенный source/version | Assignment подтверждён вручную относительно наблюдения A. | Не заменяют и не перекрывают решение. |
| `explicit_unclassified` | Assignment отсутствует; confirmed нет. | Подавляются до явного нового решения/clear. |
| `cleared` | Запись и новая revision сохраняются, assignment отсутствует; confirmed нет. | Снова допускаются только предложения. |
| `stale` | Source fingerprint не совпал; прошлый state не считается действующим confirmed. | Не заменяют прошлое ручное решение. Требуется rereview или явный clear; stale explicit_unclassified продолжает блокировать предложения до этого действия. |
| blocked / source unavailable | Некорректная/неподдержанная версия, форма или отсутствие source; confirmed нет. | Не выдавать автоматическое замещение как восстановленное решение. Orphan не публикуется. |

Из существующего состояния пользователь может явно approve, leave unclassified или clear по
ожидаемой revision и текущим source facts. Cleared на unreviewed допустим как первая ручная
reset-запись revision=1 (proposal), но не создаётся автоматически. Stale/blocked не стираются
фоновой задачей. Нет временного «истечения» без отдельной approved TTL policy: любое будущее
expiry должно fail closed; этот RFC не вводит TTL решений.

## 8. Конкретный план миграции и rollout (ничего не выполняется сейчас)

Каждый шаг — будущая отдельно утверждённая операция. Исполняемого migration script здесь нет.

1. **Preflight / go-no-go.** Утвердить §10, точный release/manifest, namespace и исполнителя.
   Независимо проверить идентичность окружения/DB name, серверную MongoDB version/FCV, topology,
   unsharded collection, privileges, write concern/durability и replica-set readiness если выбран B.
   Не выбирать БД через fallback application URI. Production assumptions сейчас UNVERIFIED.
2. **Backup.** Утверждённая согласованная backup исходной БД + catalog/index/validator manifest;
   проверить восстановление в отдельной среде, RPO/RTO и access controls. После первых решений
   backup включает classification; без проверенного restore запуск writes запрещён. Для standalone
   согласовать write pause/snapshot процедуру, не считать произвольный live dump consistent.
3. **Dry-run report (read-only, позже).** Список ожидаемых namespaces/options/indexes, наличие
   коллекции, count/duplicate tuple/missing IDs/invalid shape по bounded checks. Новая коллекция
   должна отсутствовать либо быть пустой и точно соответствовать утверждённому manifest. При
   неожиданно непустой/несовпадающей — STOP, никаких delete/dedupe/авторемонта. Не печатать записи.
4. **Writes disabled.** Отдельно одобренный серверный kill switch default-off; до его реализации
   routes отсутствуют. Флаг не авторизует доступ и не создаёт индексы. Все instances подтверждают
   off/drained writes; никакого Mongoose autoCreate/autoIndex/syncIndexes на старте.
5. **Создание.** В отдельном approved maintenance step создать пустую только эту collection с
   точным validator/options §2; затем создать unique tuple index §2.1 с заданным именем/options.
   `_id` индекс создаётся MongoDB автоматически. Не создавать history/rules/TTL и не писать source.
6. **Проверка.** Сверить namespace/validator, exact index key order/unique/simple collation,
   отсутствие partial/sparse/TTL, завершение build и пустоту. Зафиксировать migration ledger
   release/оператора/result вне финансовых документов, без credentials/financial values.
7. **Resume после interruption.** Off сохраняется. По recorded manifest проверить фактические
   collection/index states: отсутствует — выполнить оставшийся approved step; совпало — не
   пересоздавать; index строится — дождаться bounded completion; конфликт/неожиданные данные — STOP.
   Не drop/rebuild автоматически; create-index/collection шаги не одна атомарная миграция.
8. **Code rollout.** Отдельный PR adapter/model/validators и stable taxonomy; read API после
   owner-isolation tests. Совместимые readers сначала на всех instances. Далее approve source
   freshness/CAS/idempotency, safe write API и synthetic race tests на dedicated DB, затем frontend.
   Только после этого ограниченно включать writes. Неподдерживающие версию старые writers не
   запускаются с флагом on. Existing incomes/expenses не получают полей или backfill.
9. **Isolation / readiness.** Каждая source/classification операция фильтруется по server owner
   + dataset/ID; source другого owner не выдаётся, client owner не принимается. До rollout проверить
   A/B, same operationId в обоих datasets, ObjectId case aliases, malformed states, duplicate
   inserts, two-CAS race, timeout retry, source edit/delete и unsupported versions. CI guard,
   уникальные test DB names и cleanup сохраняются. Модель не даёт права на owner bypass.
10. **Rollback.** Сначала выключить и drain writes на всех instances, отключить новые UI/routes.
    Существующие решения/индекс/коллекцию не удалять и source DB не восстанавливать поверх новых
    финансовых операций. Старый reader должен безопасно блокировать неизвестную версию или быть
    выключен. Исправление forward-only с backup/отдельным approval. После возможного accepted write
    не считать пустоту доказанной по частичной проверке; автоматического destructive rollback нет.

Не меняются branch protection, CI DB guards, production settings или финансовые totals.

## 9. Audit, retention и удаление

| Подход | Гарантии | Цена / восстановление |
| --- | --- | --- |
| Одна текущая запись, revision/timestamps/lastMutation | Последнее состояние, порядок успешных CAS и bounded retry; **не** полная история и не forensic audit. | Работает без cross-document transactions. Backup возвращает последнее доступное состояние; утраченные промежуточные решения не восстановить из revision. |
| Append-only decision events + current projection | Полная история только если каждый CAS и event атомарны, с уникальностью identity+revision и idempotency protocol. | Отдельная collection/index/retention; transaction-capable topology, writer privileges, consistency/replay tests и backup обеих коллекций. Само название append-only не делает журнал tamper-proof; нужны ACL/операционные меры. |

**Рекомендация awaiting approval:** одна текущая запись для первого limited release с честным
отказом от complete audit. Если нужна история уже до первого durable write, release блокируется
до отдельного event/transaction design; best-effort async event не равен гарантированному аудиту.
`cleared` сохраняет непрерывность текущей revision, а не все прошлые assignments.

Удалённый source: orphan остаётся приватным, read не публикует его; автоматического cascade/TTL
нет. Предлагается временное хранение без автоматического удаления до утверждения конкретного
срока и механизма, с признанием privacy/storage cost, а не бессрочное разрешение retention.
Повторно появившийся same ID с identical facts неотличим в A: запрет app-level reuse исходного ID
и отдельная review policy восстановления из backup — release gate, не реализованная гарантия.

Удаление аккаунта: перед writes нужен согласованный порядок блокировки новых пользовательских
команд и owner-scoped удаления classification вместе с account data. Документ не добавляет
удаление или новый account-state/auth механизм. Текущий repository не доказывает наличие полного
account-erasure workflow: это **UNVERIFIED** и отдельный rollout blocker. Если вводится history,
append-only обязан иметь явно согласованное исключение/анонимизацию для erasure и backup retention.
Backup restore не должен незаметно воскресить erased account: план replay erasure decisions и
сроки удаления backup утверждаются операционно. Не копировать source facts в события без review.

## 10. Таблица решений для явного owner approval

Все approvals ниже **PENDING**. Выполнение C2.2 не отмечает их как принятые.

| ID / предложенное решение | Альтернатива | Рекомендация | Основной риск | Требуется approval владельца |
| --- | --- | --- | --- | --- |
| D1: schema §2, manual-only, cleared сохраняется | Поля внутри source / physical delete решения | Отдельная current collection, без backfill | Orphans, нет FK/full history | Да: exact envelope, состояния, initial clear semantics. |
| D2: unique owner/dataset/operationId | Неуникальный/partial индекс | Required tuple, full unique index | Migration/шардинг/неполный индекс | Да: namespace, validator, index manifest, unsharded precondition. |
| D3: матрица §3 | Расширить направления loans/refunds | Узкий вариант frontend как кандидат; неподдержанное не классифицировать | Неверный смысл долга/transfer/capital | Да: каждая строка и неподдержанные операции. |
| D4: stable financial-classification-v1 | Persist provisional либо иная taxonomy | Новый immutable registry после утверждения meanings | Сейчас отвергается C2.1, нужен отдельный adapter/domain PR | Да: версия, compatibility и explicit migration rules. |
| D5: Option A | Option B до первого write | A, только с принятым race/ABA/read-snapshot ограничением | Временная stale запись/отображение | Да: допустимость риска; иначе блокировать release до B. |
| D6: SHA-256 canonical v1 §4 | HMAC с keys/rotation либо иной source token | SHA-256 без raw facts в metadata | Digest не анонимизация; A→B→A не обнаруживается | Да: поля, precision/null/absent, алгоритм/версия и privacy. |
| D7: bounded lastMutation retry §5 | Durable ledger / event transactional dedupe | Последняя команда + CAS, без exactly-once claims | Нет вечного replay/detection всех reused IDs | Да: envelope/ограничения, reuse/error semantics. |
| D8: current record audit | Append-only events с первого write | Current-only limited release | История промежуточных решений утрачивается | Да: допустим ли limited audit, иначе отдельный дизайн. |
| D9: orphan/account/backup retention | TTL/cascade/долгое хранение | Без автоматики до точной approved erasure/retention policy | Privacy, restore resurrects erased data | Да: сроки, account-deletion interlock, restore/reuse policy до rollout. |
| D10: migration §8 | Auto-create/index при bootstrap | Approved manual manifest, dry-run, verified backup, default-off writes | Несовпадение окружения, interruption | Да: конкретное окружение, оператор, backup/RPO/RTO, rollout/rollback gates. |

Future rules остаются только proposals в отдельном RFC; этот документ не утверждает их
хранение, precedence engine, bulk approvals, AI/OCR или новые финансовые отчёты.

## 11. Проверки этого PR и будущие acceptance gates

Сейчас: только документация; `git diff --check`, сравнение названий/инвариантов с фактическими
C2.1 и source models/controllers, анализ существующей Node/Mongoose/CI topology.
Никаких локальных npm install/build/test, MongoDB calls, bootstrap или migration execution.
Если обновление PR запускает CI — проверить оба jobs и фактический TAP, включая parent failures,
skips/cancellations и cleanup. Существующий CI не тестирует предлагаемую persistence архитектуру.

Будущие implementation PR отдельно проверяют: strict envelope до Mongoose cast и DB validator,
все матричные роли, null/absent/empty, canonical vectors (binary64/date/Unicode/field order),
version rejection, owner A/B и dataset independence, index alias/duplicate insert races, CAS max
revision, retry и different-payload reuse, clear/reapprove, source PATCH/DELETE windows и ABA,
stale/blocked reads, orphan/erasure/restore, interrupted migration и non-destructive rollback.
Для B дополнительно обязательны replica-set tests, real source-fence write conflicts, transaction
abort/retry/failover; green standalone CI не доказательство B.

**Не реализовывать MongoDB изменения и не объединять PR без архитектурного review и явной авторизации.**
