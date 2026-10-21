# C3.3b-0 — Manual Review Proof & HTTP Write Protocol RFC

**Статус: DRAFT / REQUIRES OWNER APPROVAL.** Дата: 2026-10-21.
Только проектирование. Ни один endpoint, issuer, ключ или production write gate
этим документом не реализован и не включён. Решения H1–H10 ниже **PENDING**.
Уже утверждённые D1–D10, Option A и SHA-256 source fingerprint v1 сохраняются.

## 1. Проверенный baseline и границы гарантии

Backend `main`: `cf890a66d33ab0b67785ac75465064bc871d407e`.
Frontend `origin/main`: `056b9342e9c8003dbdcbfb00e4db4a3b80e14a80`;
просмотрен через Git без checkout/изменения frontend working tree.
Это проверка исходного кода, **не** production конфигурации или данных.

| Проверенный код | Факт и следствие для протокола |
| --- | --- |
| [auth.ts](../middlewares/auth.ts), [auth tests](../tests/auth-contract.test.cjs), [login](../controllers/users.js) | JWT verification + own `_id` из 24 ASCII hex; login выдаёт token с семидневным exp. Нет server session ID/jti, logout/revocation протокола, account-status проверки. Middleware не требует наличия exp у всех принимаемых JWT. Нельзя приписывать ему эти гарантии. |
| [User model](../models/user.js) | Есть email/password, нет active/sessionEpoch/revocation полей. Нельзя придумать проверку «active» по несуществующему полю. |
| [GET](../controllers/classificationRead.ts), [read DTO](classification-read-api.md) | `classification-read-v1`, no-store, source `{_id,owner}`, classification tuple, readiness, derived stale/blocked. GET не выдаёт source facts, digest, lastMutation или review proof. |
| [Write service](../services/classificationWrite.ts), [contract](classification-write-service.md) | Mandatory trusted resolvers, два source reads до write, CAS/unique insert, D7, post-read. Proof resolver вызывается до DB reads; success всегда confirmed:null. Сервис не подключён к routes/startup. |
| [Command](../domain/classification/writeCommand.ts), [source adapter](../persistence/classificationSource.ts) | Closed unknown inputs, stable policy, точный RFC command hash. Source adapter возвращает fingerprint, не presentation DTO; новый display adapter ещё потребуется. |
| [Persistence RFC §§4–8](individual-operation-classification-persistence-rfc.md), [readiness](classification-persistence-readiness.md) | Нет source revisions/transaction, есть ABA/DDL race; production migration, backup/restore, erasure и rollout UNVERIFIED. |
| [App](../app.ts), [CORS](../middlewares/cors.ts), [routes](../routes/index.js) | Global body-parser выполняется до routers, затем logging/CORS; новый endpoint-specific parser/error boundary нельзя считать уже существующим. CORS allowlist содержит production frontend и localhost; отсутствие allow-origin не является серверным отказом в выполнении запроса. |

Frontend ссылки ниже закреплены на просмотренном commit:

- [sessionBoundary](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/shared/api/sessionBoundary.ts),
  [sessionBaseQuery](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/shared/api/sessionBaseQuery.ts),
  [credentialObservation](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/shared/api/credentialObservation.ts):
  bearer берётся из `localStorage.token`; generation/transition guards подавляют
  устаревшие success/error, а внешние изменения замечаются через storage/focus/pageshow.
  Это локальная lifecycle bookkeeping, не серверная авторизация или ревокация.
- [UserProvider](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/entities/User/ui/UserProvider.tsx),
  [useVerifiedOwner](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/entities/User/model/useVerifiedOwner.ts),
  [cross-tab tests](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/shared/api/tests/crossTabSession.test.tsx):
  owner gate зависит от текущего `/users/me` и session-keyed subtree; наблюдённый
  A→B→A получает новую generation даже при возврате прежних credential bytes.
- [Local review hook](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/features/FinancialClassification/model/useOwnerClassificationReview.ts),
  [snapshot adapter](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/features/FinancialClassification/model/snapshotAdapter.ts),
  [types](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/features/FinancialClassification/model/types.ts):
  revisionAuthority — caller_local; snapshots содержат kopecks/timestamp и не все
  review-поля; taxonomy provisional. Это не backend revision, source observation
  или production resolver. Автоматического alias в stable v1 быть не должно.
- [Preview](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/pages/ClassificationPreviewPage/README.md),
  [card](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/features/FinancialClassification/ui/ClassificationOperationCard.tsx):
  dev-only fictional/local review; card не показывает все source title/recipient/comment.
  Её кнопку «Применить» нельзя просто подключить к write service.
- [Expense row](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/widgets/Expenses/ExpenseTable/ui/ExpenseTableRow.tsx)
  и [income row](https://github.com/mkozhevnikov2323/digit-budget-calculator/blob/056b9342e9c8003dbdcbfb00e4db4a3b80e14a80/src/widgets/IncomeTable/ui/IncomeTableRow.tsx)
  показывают amount и locale date из текущей строки. Кэш и форматирование этой
  таблицы не доказывают соответствие будущему review snapshot.

**Достижимая гарантия:** при корректной реализации и сохранности ключей backend
проверяет, что команда соответствует ранее выданному им observation+intent,
привязана к аутентифицированному actor/credential и допустимому времени приёма,
а повторно прочитанные source facts совпали с observation на проверенных чтениях.
CAS защищает revision решения. TLS защищает транспорт.

**UI-зависимая часть:** корректный frontend обязан показать именно соответствующие
этому proof данные и получить отдельное финальное действие. Backend не доказывает
криптографически, что человек увидел, прочитал, понял или сам выбрал эти значения.
Авторизованный скрипт способен выполнить те же вызовы без человека. `confirmed:true`,
название кнопки и browser nonce не добавляют такого доказательства.

## 2. Threat model

Защищаем source facts, текущие ручные decisions, credential/proof, actor isolation,
порядок revision и честное сообщение о результате. Сеть недоверенная; TLS обязателен.
Request body/headers, frontend drafts и browser lifecycle claims не являются
серверным authority. Доверенными остаются auth chain, resolvers, криптокод,
конфигурация ключей и отдельно проверенная DB infrastructure.

| Угроза | Предлагаемая защита | Остаточный риск / ограничение |
| --- | --- | --- |
| Forged proof, client owner/digest | AEAD, closed claims, owner из JWT; raw owner/fingerprint в DTO запрещены | Компрометация issuer/key или неверный resolver разрушает attestation |
| Старый proof после amount/date/comment/title/etc edit | Hash исходного observation против двух reads C3.3a | PATCH после последнего read и A→B→A не исключаются |
| Другой owner/dataset/operation | Exact canonical identity binding в claims, context и command; owner-scoped queries | Валидный JWT не доказывает существование/статус аккаунта без отдельной проверки |
| Другая роль/layer/state/revision/requestId | Все поля intent аутентифицированы; stable v1 only | UI должен заново готовить review при изменении выбора |
| Expired/replayed proof | Admission expiry; D7 latest-command dedup + CAS | Proof не single-use; unlimited history отсутствует |
| Украден только proof | Для apply нужны тот же проверенный bearer и actor | Proof+JWT достаточны; украденный JWT также позволяет запросить новый proof |
| A→B→A / другой tab | Credential hash + browser context binding, local generation purge | При возврате того же JWT backend не узнаёт о logout; nonce клиента не доказывает lifecycle |
| Concurrent tabs / double click | Один frozen command на UI attempt; UUID и expectedRevision; unique/CAS | Один tab может выиграть раньше другого; не делать silent rebase |
| Timeout / пропавший response | Same-command retry или отдельный read-only reconciliation | Abort не rollback; previous attempt может быть applied |
| XSS | Escaped text, no HTML interpretation, memory-only proofs, отдельная CSP/dependency hygiene | Same-origin XSS может украсть localStorage JWT и обойти UI; AEAD этого не исправляет |
| CSRF | Explicit bearer, JSON-only, проверка Origin на новых browser POST | CORS сам по себе не authorization; при cookie auth нужен новый CSRF design |
| Browser/shared cache / telemetry | no-store, lifecycle invalidation, исключение bodies/tokens из logs/APM | Уже показанные пользователю данные/DevTools не становятся секретом от него |
| Key rotation/rollback / clock rollback | Fleet key policy, bounded TTL/usage, revoked keys не возвращать, trusted time | Stateless proof не даёт per-token logout revocation; arbitrary clock rollback может продлить применимость |
| Multi-instance divergence | Shared approved keyring/deployment identity/version, fail-closed health | Локальный session store/counter без fleet protocol не обеспечивает согласованность |
| Concurrent DDL/restore/ID reuse | Writer drain/exclusion, exact readiness, новая proof era после restore | Preflight не atomic fence; восстановленная БД не является полной историей D7 |

## 3. Три механизма и рекомендация H1

| Критерий | A — stateless AEAD | B — server-held review session | C — signed readable token |
| --- | --- | --- | --- |
| Содержимое у клиента | Opaque ciphertext; видны version/kid/length | Случайный opaque reference | Читаемые claims даже при base64url |
| Источник/intent binding | В authenticated encrypted claims | В серверной записи | В подписанных claims |
| SHA-256 privacy | Digest внутри ciphertext, не в открытом DTO | Digest только в state store | Digest/actor/intent/revision/times раскрываются, если включены |
| Дополнительное хранение | Не нужно для proof; остаётся D7 current record | Новый Mongo namespace либо отдельно подтверждённый external store | Не нужно для proof |
| Restart / несколько instances | Работает с общими keys/policy/time | Нужны replication, persistence, согласованные read/consume | Общие verification keys/time |
| Expiration / отзыв | Clock check; key/fleet era revocation; не single-proof logout | Явная expiry проверка + deletion/TTL; можно отозвать reference | Expiry/key revocation; signing не добавляет session state |
| Replay | D7/CAS; не single-use | Consume возможно, но consume/write atomicity ещё надо спроектировать | D7/CAS либо отдельный store |
| Влияние на D1–D10 | Текущие storage решения сохраняются | Потребуются approval storage, D7/lifecycle, D9 erasure/retention/restore | Privacy justification нужна отдельно |
| Цена/риск | AEAD nonce/key management, expiry recovery | Доступность store, cleanup/erasure и дополнительные failure windows | Простота integrity не решает требуемую confidentiality |

**Рекомендуется A, только после H1–H10.** При текущем запрете новой коллекции он
оставляет persistence foundation неизменным. Это снижение объёма infrastructure,
не утверждение, что stateless всегда безопаснее stateful.

Для B случайный reference должен иметь не менее 128 CSPRNG bits, быть привязан к
actor/intent и не приниматься без JWT. Mongo TTL удаляет асинхронно: expiry всё равно
проверять на каждом use. Consume-before-write может потерять попытку, consume-after-write
имеет race; две коллекции сами по себе не дают exactly-once. Нужны отдельный протокол
и, при необходимости, одобренные transactions. External store в просмотренном коде
не установлен; фактическая production infrastructure **UNVERIFIED**, её существование
не предполагается. In-memory per-instance map не годится для restart/load balancing.
Нужны erasure, retention, backup/replication, eviction/restart recovery решения.

Для C подпись/MAC защищает integrity, а не confidentiality. Base64 — не шифрование.
Нельзя без отдельного privacy approval выдавать readable source digest, owner,
credential binding, intent/revision и temporal metadata. Исключение digest потребует
другого способа хранения binding — фактически A/B либо нового дизайна.
`JWT_SECRET` ни в одном варианте не переиспользуется автоматически.

## 4. Предлагаемый AEAD proof v1

Предлагаемый wire format (это спецификация, не созданный token):

```text
crp1.<kid>.<nonce-base64url>.<ciphertext-base64url>.<tag-base64url>
```

- Фиксированный AES-256-GCM, ключ 32 bytes, nonce 12 CSPRNG bytes, tag 16 bytes.
  Нет client-selectable alg, compression или algorithm fallback.
- `kid`: 1–32 ASCII `[a-z0-9_-]`, начинается с letter/digit; lookup только в
  конфигурируемом in-memory allowlist, никогда path/URL/динамический fetch.
- Canonical unpadded base64url, ровно 5 segments; проверка re-encoding/размеров.
  Ciphertext/plaintext <=2048 bytes, весь ASCII proof <=4096 bytes. Не парсить
  plaintext JSON и не использовать claims до успешного GCM tag verification.
- AAD: compact UTF-8 tuple `['budget-classification-review',1,deploymentId,kid]`.
  `deploymentId` — фиксированная approved environment/proof-era identity, общая
  для instances; не берётся из Host, body или произвольного forwarded header.
- JSON plaintext — closed, server-generated claims следующей формы:

```text
{proofVersion:1, purpose:"manual-classification-review",
 audience:"classification-command-v1", deploymentId:<configured>,
 proofId:<server CSPRNG UUID-v4>, actor:<canonical owner>,
 credentialBinding:<private SHA-256>, browserReviewContext:<UUID-v4>,
 dataset:"expenses"|"incomes", operationId:<canonical ObjectId hex>,
 sourceFingerprint:<private SHA-256>, sourceFingerprintVersion:1,
 taxonomyVersion:"financial-classification-v1", kind:"manual_classification",
 state:"approved"|"explicit_unclassified"|"cleared", assignment?:<stable assignment>,
 expectedRevision:null|<positive safe integer>, requestId:<canonical UUID-v4>,
 issuedAt:<integer UTC seconds>, expiresAt:<integer UTC seconds>}
```

Assignment требуется только для approved и полностью отсутствует иначе. Layer
обязателен внутри assignment: supported string для ordinary_expense, null для остальных.
Все identity/intent/version поля проверяются после decrypt, без coercion/defaults.
Raw amounts, dates, titles, recipients, comments и raw JWT в plaintext **не входят**.
Digest внутри ciphertext не становится анонимными данными: его также не логировать.
Владелец, уже получивший свои facts и знающий RFC, может самостоятельно вычислить
SHA-256. Скрытие поля в proof уменьшает утечки metadata, а не делает собственные
данные владельца криптографически неизвестными ему.

`credentialBinding` = SHA-256 compact UTF-8 tuple
`['classification-review-credential',1,exactVerifiedBearer]`. Он скрыт AEAD, не
передаётся клиентом отдельно и не является новым credential. Проверять binding
текущего verified bearer при apply; не использовать email или decoded client JWT.
Login без sid/jti не гарантирует новую уникальную сессию даже при каждом входе:
одинаковые claims/секундные timestamps могут дать те же token bytes.

`browserReviewContext` создаёт frontend CSPRNG UUID-v4 на один tab/auth generation/
review lifecycle; он ephemeral и сравнивается с proof. Это защита от случайного
переноса drafts, **не серверное доказательство logout/tab identity**. Клиент может
скопировать старый nonce, а при тех же credential bytes backend не увидит A→B→A.
Если нужна строгая серверная session revocation, A в этом объёме недостаточен:
сначала отдельно утвердить server session/epoch protocol. Не подписывать локальную
generation и не называть её от этого серверным фактом.

### 4.1. TTL, ключи и multi-instance policy (H3/H4)

Предложение: TTL <=300 секунд, `expiresAt=min(issuedAt+300, verifiedJwt.exp)`.
Для новых review/apply routes рекомендовать finite integer JWT exp и существующий
account; middleware остальных API не менять. Missing exp → 401/re-auth для новых
routes, а не выдуманная гарантия уже существующего auth. Максимальный future-iat
skew 30 секунд; expiry без дополнительной write grace. Требуются доверенные clocks:
проверять `issuedAt<=now+30`, `issuedAt<expiresAt`, lifetime<=300, `now<expiresAt`.

**Expiry определяется при admission в trusted resolver**, не временем commit:
C3.3a проверяет proof до DB reads и не имеет commit-deadline hook. Уже принятая
команда может завершиться после exp. Abort/deadline не доказывает rollback. Более
строгий commit-time deadline — отдельное изменение service protocol, не свойство
этого RFC. На frontend малый остаток TTL блокирует кнопку только как UX-мера. Public
expiresAt/client clock — подсказка UI; resolver доверяет только authenticated
claims и серверному времени в момент своего вызова, не ранней проверке handler.

Предлагаемые имена будущих конфигурационных bindings (значения не создаются):
`CLASSIFICATION_REVIEW_KEYRING`, `CLASSIFICATION_REVIEW_ACTIVE_KID`,
`CLASSIFICATION_REVIEW_DEPLOYMENT_ID`. Ключи purpose-specific из approved secret
manager, не JWT_SECRET, не repository/frontend/Vite config. Strict decode 32 bytes,
уникальные kid, один active issuer, ограниченный allowlist и health без key values.

- Fresh nonce на каждое encryption, включая повторный prepare; не время/Math.random.
  При random 96-bit nonce collision probability ненулевая. Предлагаемый conservative
  budget <=2^20 issuances на key по всему fleet и rotation не реже 30 дней, раньше
  при budget exhaustion. Примерная birthday bound при 2^20 — 2^-57; это не абсолютная
  уникальность. До запуска нужен проверенный fleet accounting/quota механизм,
  включая restarts, либо отдельно одобренная nonce-allocation policy. Не считать
  per-process counter после рестарта fleet limit. Здесь механизм не реализуется.
- Раздать новый decrypt key всем instances → проверить совместимость → переключить
  active issuer → старый оставить apply-verification до истечения его последних
  300-second proofs, затем только read-only reconciliation (до 24h горизонта ниже).
- Key policy ограничивает issuance interval и allowed uses; key недоступен/malformed,
  версии расходятся или trusted time нездорово — соответствующие routes дают 503.
  Unknown/disabled kid в запросе при здоровом ring → generic 403, без key details.
- При компрометации немедленно disable key на всех instances, не оставлять его для
  «удобного retry». Per-proof revocation без store отсутствует. Задним числом
  неподтверждённую историю таким отзывом не восстановить.
- Security policy/disabled keys/era не откатываются вместе со старым binary/config
  backup. При rollback несовместимый issuer/writer остаётся off. После DB restore
  сменить proof era и инвалидировать старые proofs до нового review; не считать
  восстановленные lastMutation/revision полным audit trail.

## 5. Workflow и соответствие показанных фактов

Рекомендуемый минимум: два POST для prepare/apply и третий **read-only POST** для
bounded reconciliation, плюс существующий GET. Третий нужен для timeout с истёкшим
proof; альтернативой является блокировка recovery до отдельного решения, а не
разрешение expired-proof execute. Новый namespace/ledger для этого не нужен.

1. Открыть операцию в authenticated, session-keyed UI. Существующая строка и её
   locale/kopecks presentation — только предварительный контекст. Получить текущий
   `classification-read-v1`. Только unreviewed даёт explicit null sentinel; null
   metadata у blocked нельзя превращать в «записи нет». Stale валидное решение
   сохраняет свой storedState/revision и не заменяется предложением автоматически.
2. Пользователь явно выбирает stable role/layer либо explicit_unclassified/cleared.
   Не предвыбирать AI/recurrence output как подтверждённое решение. Создать requestId
   для этой ручной попытки; expectedRevision берётся из актуального backend GET,
   никогда из caller_local revision/useOwnerClassificationReview.
3. POST reviews передаёт intent/revision/requestId/browser context. Это ещё не write.
   Backend проверяет actor, gates, account, readiness, source `{_id,owner}`, полный
   current decision tuple. Mismatch revision → 409, без silent rebase на новый counter.
4. Из **одного owned validated native source snapshot** подготовить display DTO и
   fingerprint v1, затем AEAD proof с этим fingerprint и exact intent. Не делать
   отдельный read для «данных на экране» и другой для hash. Не выдавать digest.
   Новый display adapter нужен: существующий fingerprint adapter не возвращает facts.
5. Ответ reviews заменяет весь confirmation snapshot. Даже если данные не совпали
   с таблицей/старой формой, ничего не сохранять автоматически. UI показывает все
   возвращённые facts, новый target decision, предыдущий manual state/revision и
   отдельную кнопку финального подтверждения. Несовпадение с предварительным view
   должно быть видно; неполный/неподдержанный DTO блокирует подтверждение.
6. Смена выбора, source refresh, owner/auth generation, tab review lifecycle или
   operation делает proof непригодным для UI. Новый review/requestId и новый явный
   confirmation обязательны. Нельзя подменить snapshot под уже активной кнопкой.
7. Только отдельное финальное действие отправляет frozen command + proof в POST
   commands. `confirmed:true` не принимается. Handler вызывает C3.3a с trusted context
   и verified observation; compute-on-save не создаёт новый proof.
8. Один in-flight apply на operation/context, double click не создаёт новый UUID.
   Не сбрасывать draft/закрывать UI как успешный до acknowledgement. После applied/
   replayed отдельно refetch существующего GET; acknowledgement не confirmed assignment.
9. При конфликте/изменении фактов — показать безопасное состояние, refetch, затем
   только новый ручной review. При timeout/unknown — §8, без автоматической новой команды.

Proof, frozen pending command и полный review snapshot — в памяти текущего review
компонента; не в localStorage/sessionStorage/URL/cookie/persisted Redux/RTK query
cache/devtools actions/analytics. При смене generation сначала invalidate/unmount,
затем принять новый credential как в существующем UserProvider. Старые promises,
closures и ошибки не открывают UI/не запускают retry в новой generation; очистить
контекст также при restore страницы из bfcache. Browser events не мгновенны.

Abort при logout/navigation не отменяет уже принятую backend mutation. При refresh/
потере памяти исчезают requestId/proof для exact recovery: refetch GET допустим,
но он не доказывает результат старой команды. Не генерировать и не отправлять её
заново автоматически. Durable client recovery потребует отдельного privacy/storage
approval; этот RFC его не предполагает.

### 5.1. Authorized display projection и privacy (H7)

Общие facts: `amount:{format:'binary64-roundtrip-decimal',value:string}`,
`dateEpochMs:<exact safe integer UTC milliseconds>`, tagged `comment`.
Expenses дополнительно: exact persisted `category,title,recipient`;
incomes: exact persisted `source`. Других document/storage/owner полей нет.

Amount value — shortest JS Number round-trip decimal, с отдельной строкой `'-0'`
для negative zero; допустима экспонента. Это обратимое представление имеющегося
binary64, не заявление о точных десятичных деньгах. Не округлять до копеек и не
проводить через текущий analytics kopecks adapter/formatKopecks. Date показывать с
полным UTC timestamp/миллисекундами, не только locale calendar date. Локализованное
представление может быть дополнительным, не заменой точного.

Comment: `{kind:'missing'}` / `{kind:'null'}` / `{kind:'value',value:<exact string>}`.
Пустая строка отличается от missing/null. Строки не trim/case-fold/normalize;
показывать escaped plain text с whitespace-preserving/raw view для неоднозначных
символов. Нет dangerous HTML. При невозможности корректного отображения/валидации
fail closed; не усекать поля и не скрывать recipient/comment/title за summary.

Предлагаемые limits: <=8192 UTF-8 bytes на каждую строку, <=32768 serialized UTF-8
bytes на все facts, <=65536 bytes review response. Превышение → 413, **без** token,
truncation или изменения source. Это ограничение нового review, не legacy CRUD.
Полные facts сознательно возвращаются только владельцу по TLS; они чувствительны
даже если proof зашифрован. Их нельзя отправлять в стороннюю telemetry/AI/APM.

## 6. Предлагаемые HTTP DTO и ошибки (H2/H8)

Все три пути ниже **не существуют как реализованный API**. Exact dataset literals,
24 ASCII hex operationId (canonical lowercase для binding), no query parameters.
Все JSON objects closed; неизвестные поля/owner/digest/timestamps/confirmed, duplicate
JSON keys, array/scalar body и coercion отвергаются. Assignment conditional как §4.
UUID-все поля строго canonical lowercase v4; expectedRevision null или safe integer >=1.
Path identity добавляется сервером; `kind:manual_classification`/taxonomy — фиксируются
сервером, а не копируются из произвольного client metadata.

### 6.1. POST /classifications/:dataset/:operationId/reviews

```json
{
  "version": "classification-review-request-v1",
  "browserReviewContext": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "requestId": "12345678-1234-4234-8234-123456789abc",
  "expectedRevision": null,
  "state": "approved",
  "assignment": { "economicRole": "ordinary_expense", "layer": "everyday" }
}
```

200 example, только вымышленные facts; placeholder не является token:

```json
{
  "version": "classification-review-v1",
  "dataset": "expenses",
  "operationId": "111111111111111111111111",
  "taxonomyVersion": "financial-classification-v1",
  "browserReviewContext": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "currentDecision": { "storedState": null, "decisionRevision": null },
  "intent": {
    "requestId": "12345678-1234-4234-8234-123456789abc",
    "expectedRevision": null,
    "state": "approved",
    "assignment": { "economicRole": "ordinary_expense", "layer": "everyday" }
  },
  "facts": {
    "amount": { "format": "binary64-roundtrip-decimal", "value": "12.34" },
    "dateEpochMs": 1736942400000,
    "category": "Транспорт",
    "title": "Бензин",
    "recipient": "Вымышленная АЗС",
    "comment": { "kind": "missing" }
  },
  "reviewProof": "<opaque-review-proof>",
  "expiresAt": 2000000300,
  "consistency": "observed_only_non_atomic"
}
```

Для incomes facts содержат source вместо category/title/recipient. currentDecision
содержит только полностью проверенные manual state/revision либо оба null при
проверенном отсутствии записи. Это не effective confirmed assignment. Intent точно
повторяет проверенный request, без подмены expectedRevision. Preview/provisional
версии frontend не считаются совместимыми автоматически.

### 6.2. POST /classifications/:dataset/:operationId/commands

Body — ровно request из §6.1 с `version:'classification-command-v1'` и дополнительным
обязательным `reviewProof:string`. Нет facts/owner/source digest в request. Handler
проверяет каждое поле против sealed intent и context, затем строит ManualCommand.
201 при created (включая initial clear/unclassified), 200 при updated/replayed:

```text
{version:"classification-write-ack-v1",dataset,operationId,requestId,
 outcome:"created"|"updated"|"replayed",
 storedState:"approved"|"explicit_unclassified"|"cleared",
 decisionRevision:<safe integer>,
 sourceStatus:"matching_observed"|"stale"|"missing"|"invalid"|"unavailable",
 confirmed:null,consistency:"observed_only_non_atomic"}
```

Это явная проекция C3.3a, не raw service object/BSON. Даже 201 со stale/missing/
unavailable не откатывает write и не разрешает показать «подтверждено актуальными
данными». Fetch GET отдельно. Существующий `classification-read-v1` не расширяется:
все его 8 полей, статусы, ошибки и gate остаются прежними.

### 6.3. POST /classifications/:dataset/:operationId/commands/reconcile

Body совпадает с §6.2, но `version:'classification-reconcile-request-v1'`.
**Read-only**, никогда не вызывает `execute`, даже при valid/unexpired proof.
Его минимальность обусловлена отсутствием request/lastMutation в текущем GET.

Для этого пути допускается expired proof только после полной AEAD/claim/intent
проверки и только до `issuedAt+86400` (24h). Это отдельный verification mode, который
не может попасть в apply resolver. Expiry exception применяется только к proof,
не к authentication JWT, key disablement или future-issued token. Все остальные проверки сохраняются: текущий
valid **тот же exact bearer**, тот же actor/browser review context, account existence,
key policy, era и intent. JWT expiry/key retirement могут закончить recovery раньше
24h. Re-login с иным credential не даёт права повторно использовать старый proof
даже для этого пути; cross-credential recovery потребует отдельного дизайна.
UI recovery выполняется только в ещё текущем verified lifecycle. После его потери
GET может показать текущее состояние, но не доказывает старый commit.

Owner-scoped source/decision reads, полная stable validation и RFC command hash
из проверенного старого observation. Если latest lastMutation ID/hash и фактические
state/assignment/revision/source metadata соответствуют команде, вернуть:

```text
{version:"classification-reconcile-v1",dataset,operationId,requestId,
 result:"latest_applied",receipt:{storedState,decisionRevision,
 sourceStatus:"matching_observed"|"stale"},
 confirmed:null,consistency:"observed_only_non_atomic"}
```

Если запись отсутствует или latest ID иной: 200 с `result:'indeterminate',receipt:null`
и остальными теми же полями. Это **не** доказательство «не применялась»: history могла
быть вытеснена/восстановлена. Same latest ID с другим digest → 409. Source проверяется
до metadata; missing/deleted/foreign source → одинаковый 404 без orphan receipt,
invalid/unavailable source/record/infrastructure → safe failure. Повторный source
read для receipt не превращает observation в atomic snapshot.

Нужен новый отдельно тестируемый read-only adapter на существующих mapper/hash
helpers; такой adapter в C3.3a не реализован. Запрещён shortcut «передать expired
proof в service и надеяться, что это replay»: missing record может привести к insert.
Ни consumed marker, ни ledger, ни cleanup коллекции не добавляются. Revoked/missing
key или старшая версия/era не принимаются даже для recovery. За пределами retention
результат может оставаться неразрешимым; не обещать восстановление audit history.

### 6.4. Общие HTTP ограничения

- TLS; existing JWT authentication, no cookie auth; body только application/json.
  Новые routes дополнительно проверяют account existence и конечный exp по H6;
  это не изменение existing middleware/GET и не обещание token revocation.
- Target limit 8192 decoded request bytes, proof <=4096 ASCII bytes. Future bounded
  parser должен проверять raw/decompressed size и duplicate keys именно для новых
  POST. Текущий global body-parser/100KiB default и JSON.parse после parsing этого
  не обеспечивают. Узкое parser + sanitized error boundary wiring — implementation
  gate с сохранением legacy parser/auth/logging contracts; сейчас ничего не меняется.
- Все новые responses, включая errors/auth failures: `Cache-Control:no-store`,
  `Vary:Authorization,Origin`; no ETag/304/shared cache/service-worker caching.
  Proof только в JSON body, не URL/query/cookie. Existing GET не менять ради этого.
- Browser Origin должен точно совпасть с approved frontend allowlist; null/иной
  Origin → 403 на новых POST. Missing Origin допускает non-browser client только
  при полном bearer/proof protocol; Origin не является cryptographic identity.
  Не полагаться на один CORS response header; не расширять allowlist автоматически.
- Existing explicit bearer не отправляется HTML form как ambient credential;
  JSON/preflight/Origin — дополнительная CSRF защита. При будущем cookie auth нужен
  отдельный CSRF/token/SameSite дизайн. XSS с bearer способен пройти весь протокол.
- No financial facts, headers, proof, decrypted claims, digests или raw errors в
  File/console/APM/proxy/client logs. B3g allowlist сохраняется. Надо отдельно
  проверить инфраструктурные body captures; middleware logging не доказывает их
  отсутствие. Bounded rate limits на issuance/invalid proofs и nonce budget — gate.

Proposed new error DTO после endpoint-specific error boundary:
`{version:'classification-http-error-v1',error:{code:<enum>},persistence:'not_applied'|'unknown'}`.
Это статус **данной попытки**, не отрицание commit предыдущего запроса. Existing
JWT middleware может сохранить legacy 401 `{message}`; UI обрабатывает status и
не требует нового error DTO от старого auth path. Cache header применяется до auth.

| HTTP | code / причина | Действие UI |
| --- | --- | --- |
| 400 | invalid_request: shape/ID/dataset/UUID/revision/unknown fields | Исправить intent, новый review; не повторять mutation автоматически |
| 401 | unauthenticated / reauth_required / account absent | Завершить текущий review lifecycle; existing auth contracts сохраняются |
| 403 | invalid_review: bad tag/kid/actor/credential/path/intent/context; forbidden_origin | Generic, без diagnostic claims/key details; не использовать proof повторно |
| 404 | operation_not_found: missing/deleted/foreign source | Не выдавать orphan metadata; prior unknown не считать rollback |
| 409 | stale_review / revision_conflict / request_id_conflict / revision_overflow / blocked_decision | Refetch и явный новый review, без rebase/repair |
| 410 | review_expired / reconciliation_window_expired, после authenticated own-proof проверки | Только допустимый read-only recovery, не renew-and-save |
| 413 / 415 | review_too_large / request_too_large / unsupported_media_type | Ничего не усекать/не записывать |
| 503 | unavailable: gate/keys/time/readiness/source read failures | Не показывать unreviewed/успех; retry eligibility по §8 |
| 500 / 503 | internal_failure / persistence_unknown | Sanitized; сохранить uncertainty и frozen command |

Для ошибки после возможной записи — persistence:unknown. Ранний отказ до execute
не добавляет записи, но не снимает uncertainty прежнего timeout. Unsupported stored
taxonomy/fingerprint → blocked_decision; deployment/crypto-version mismatch → отказ,
не downgrade. Unknown future error codes UI трактует fail-closed, без автоповтора.

## 7. Production resolvers поверх существующего C3.3a (H5/H6)

`resolveAuthenticatedOwner` получает private per-request context, созданный только
после успешного existing JWT guard. Доверенный factory связывает actual request,
проверенный principal, exact verified bearer, canonical owner и account/exp eligibility.
Хранить snapshot в closure/WeakMap; body `{owner,_id,authenticated:true}` и raw req.user,
переданный из произвольного caller, не создают capability. Не менять JWT signing,
verification algorithms, middleware или secret в этой фазе.

`resolveVerifiedReview(context,evidence,checkedCommand)` в apply mode:

1. Проверить trusted context/gates/key health и bounded proof representation.
2. Decrypt/authenticate с фиксированными purpose/audience/deployment/version/AAD.
3. Проверить current actor и exact bearer binding; exp/iat/TTL/key policy; browser
   context и canonical path identity. Browser context лишь проверяется на равенство.
4. Сравнить kind/taxonomy/state/assignment/expectedRevision/requestId с immutable
   `checkedCommand`; нельзя заменить его данными из token или принять иной intent.
5. Вернуть **только** existing closed projection `{kind:'verified_manual_review',
   owner,dataset,operationId,sourceFingerprint,sourceFingerprintVersion:1}`.
   Не передавать весь decrypted payload в strict C3.3a validator.
6. Service сам выполнит current-source comparison, repeated source read, readiness,
   CAS/D7. Resolver ничего не выпускает из save-time source read.

Для классификации HTTP error безопасный private failure reason может храниться
в request-local context, а наружу идти generic code; не протаскивать exception
messages через service. Cryptographic validation не заменяет owner-scoped queries.

Предлагается `User.exists({_id:owner})` на новых review/apply/reconcile admission:
никаких password/email проекций, существующие модели не менять. Это existence на
момент проверки, не account lock или защита от concurrent erasure. Нельзя проверять
«active» по несуществующему полю. Принятие этой eligibility policy отдельно H6;
иначе нельзя приписывать её текущему middleware. Stolen valid JWT остаётся credential;
протокол не решает глобальную logout revocation и account-ID reuse.

## 8. Request ID / CAS / retry state machine

| Ситуация | Правило |
| --- | --- |
| Новый ручной intent/review | CSPRNG requestId, exact expectedRevision из backend; выбор пользователя обязателен |
| Prepare потерян/отменён до apply | Можно начать новый prepare с новым ID и final confirmation: записей ещё не было |
| Prepare ответ пришёл с новыми facts | Показать именно их; если это замена уже подготовленного snapshot — новый review/ID, не переиспользовать старую кнопку |
| Double click apply | Один frozen body/proof/requestId; не две самостоятельные команды |
| Timeout или persistence:unknown, proof ещё valid и generation та же | Явный retry **того же** body/ID/revision/proof; не generic automatic transport retry |
| Latest identical request уже применён | C3.3a replay без новой revision/timestamp; refetch GET |
| Same latest ID, иной intent/expected/source hash | Конфликт; это не retry |
| Intervening accepted command / другой tab | Old exact retry конфликтует; не подставлять новый expectedRevision |
| Expired proof при uncertain apply | Не вызывать execute; read-only reconcile в 24h горизонте |
| Re-login / JWT expiry до reconcile | Старый proof не принимается; GET отражает только текущее состояние, history остаётся unknown |
| Reconcile latest_applied | Acknowledge конкретную applied revision, затем GET; matching_observed не confirmed |
| Reconcile indeterminate / key revoked / source gone | Не считать not-applied; refetch current GET и явное решение пользователя, без blind retry/new ID |
| Source stale до save | 409, zero new write текущей попытки; prior timeout может уже иметь commit |
| Source stale/missing после commit | Applied acknowledgement с confirmed:null; не повторять как новый intent автоматически |
| Proof exp истёк во время уже admitted write | Ответ остаётся applied/unknown по фактическому результату; commit-time expiry не гарантируется |
| Reload/logout с потерей pending memory | Нет гарантии exact recovery; старый background callback не создаёт новую попытку |

После любого отправленного apply запрещено «обновить proof» новым prepare и затем
автоматически повторить save. Истёкший proof не продлевается ради replay, тем более
не пересчитывается source hash для якобы прежнего review. После разрешения/признания
uncertainty пользователь может явно создать **новую** команду относительно текущего
состояния; это новое действие с новой revision, не обещание exactly-once.

Command hash остаётся точным RFC §5/C3.3a tuple. Proof nonce/id/key/timestamps/browser
context не входят в command hash. Renewed crypto wrapper не превращает иной source
или intent в идентичную команду. D7 хранит только последнюю mutation: old exact retry
после нового решения неуспешен, но reuse старого ID с новым intent/current revision
после вытеснения не обнаруживается. Full history/вечный replay/single-use token не
обещаются; новый ledger или consumed-proof store не одобрены.

## 9. Readiness, rollout и rollback (H4/H9)

Предлагаемый **новый** exact server gate `CLASSIFICATION_WRITE_ENABLED=1`; любое
другое/отсутствующее значение — off. Он не включает существующий READ gate.
Review prepare/apply требуют также READ=1, key/clock/account readiness и точного
Mongo manifest/index. Write=1 при READ=0 остаётся unavailable. Никаких create,
autoIndex/autoCreate/syncIndexes/migration/fallback URI от включения флага.

Read-only reconcile требует READ=1, verification-key readiness и exact manifest,
но допускается при WRITE=off для безопасного recovery после kill switch. Active
issuer не нужен для verify-only recovery; misconfigured/disabled verification
keys fail closed. Все off/key failures до execute не вызывают classification writes.
Существующий GET зависит только от своего прежнего READ gate и не требует proof keys.

До первого rollout отдельно подтвердить:

- Exact namespace, Mongo version/FCV/unsharded topology, durability/write concerns,
  least privileges и full manifest/unique index; dry-run не чинит mismatch.
- Consistent backup + проверенный restore/RPO/RTO, erasure/retention и запрет
  небезопасного reuse account/source IDs; новые proofs не исправляют старую identity model.
- Administrative DDL/restore exclusion: выключить/drain writers на **всех** instances
  перед drop/rename/collMod/index maintenance. Preflight не atomic namespace fence;
  insert может неявно создать collection при concurrent drop. Перед backup/erasure
  также согласовать исходные financial writers. Option A остаётся выбранным.
- Отдельное key provisioning, nonce budget, time health, staged verifier→issuer
  deployment, version compatibility и rollback без возврата revoked key/proof era.
- Endpoint-specific bounded parser/error/cache/Origin behavior и logging/APM audit,
  stable frontend renderer/session lifecycle, synthetic nonproduction smoke tests.
- READ можно включить отдельно; writes только после review, gates/readiness и
  явного operator enablement. Kill switch останавливает новые admissions, но не
  отменяет уже принятые/неопределённые writes; drain и reconciliation обязательны.

Rollback: WRITE off → drain → readonly recovery при здоровых keys/READ → откат
несовместимого issuer/UI без удаления решений/индексов и без восстановления старой
source DB поверх новых операций. Не активировать старый keyring автоматически.
Если кода/ключей для безопасного recovery нет, сохранять unknown, а не подделывать
отрицательное подтверждение. Все production operational пункты сейчас UNVERIFIED.

## 10. Матрица будущих synthetic tests (H10)

Это **план**, не выполненные tests нового протокола. Future implementation должна
сохранять existing backend/frontend contracts и test-only Mongo guards/cleanup.

| ID | Сценарий | Обязательное ожидание |
| --- | --- | --- |
| T01 | Valid owner, prepare exact snapshot, final manual apply expense/income | Intent/facts/proof coherent; один write; ack confirmed:null; GET отдельно |
| T02 | Другой owner/JWT, body owner/digest/_id | Reject; никакого cross-owner disclosure/financial DML |
| T03 | Другой operation/dataset, hex aliases/newline/nonhex | Canonical same identity допустим; mismatches/malformed отвергнуты |
| T04 | Role/layer/state/expectedRevision/requestId изменены после prepare | Proof mismatch, zero new writes |
| T05 | Amount/date/category/title/recipient/source/comment изменились до apply | Stale/invalid, без нового write; exact Unicode/whitespace/absent-null-empty |
| T06 | +0/-0, fractional binary64, exponent, UTC millisecond edges | Exact display round-trip и fingerprint; no kopecks rounding/locale truncation |
| T07 | Source меняется между hash и presentation | Issuer использует один owned snapshot; нельзя смешать два reads |
| T08 | Неполная/неподдержанная presentation, oversize comment/facts | Нет proof/confirmation/truncation; safe failure |
| T09 | Expiry до admission / future iat / exp отсутствует у JWT | Reject по выбранной eligibility; no expiry default/grace |
| T10 | Expiry после resolver admission, до DB commit | Только заявленная admission guarantee; applied/unknown не маскируется |
| T11 | Bad tag/nonce/segment/base64url/oversize/unknown kid/version | Bounded generic failure, no plaintext parsing/logs/DML |
| T12 | Header/AAD/deployment/audience/purpose/claims tamper | Reject без downgrade; no network/file key lookup |
| T13 | Active→old verify→reconcile-only→disabled key, missing/malformed ring | Multi-instance acceptance по policy; revoked proof всегда reject |
| T14 | Issuance на instance A, apply/reconcile на B после restart | Shared deployment/key/time policy; нет зависимости от local map |
| T15 | Fleet nonce quota, restart и security-config rollback | Exhaustion/drift off; nonce не переиспользуется; disabled keys не воскресают |
| T16 | A→B→A, включая те же token bytes, local/external logout | UI purge/new context; old callbacks не отправляют/не показывают save; backend limitation явно проверена |
| T17 | Разные tabs с одним bearer и своими browser contexts | Нет accidental draft/proof adoption; CAS winner/conflict |
| T18 | Double click, concurrent initial insert/CAS | Один winner; identical latest request replay, без второй revision |
| T19 | Lost insert/update ack, valid-proof retry | Exact same command; real MongoDB one-write/idempotency assertions |
| T20 | Expired-proof unknown retry | Apply 410, reconcile read-only; trap всех DML/DDL/execute calls |
| T21 | Reconcile no record / latest иной / same ID different intent | indeterminate либо conflict; никогда insert/false not-applied |
| T22 | Reconcile новым credential того же owner / другим owner | Credential/actor mismatch rejected даже в read-only mode; старый apply не возобновляется |
| T23 | Между командой и reconcile новое решение / cleanup/restore | Bounded lastMutation, не обещать history; no silent retry |
| T24 | Old ID с изменённым intent после intervening command | D7 limitation зафиксирована, не объявлять durable dedup |
| T25 | Invalid UUID/revision, overflow, unknown fields/duplicate keys/scalar body | Sanitized 400; no coercion/filter/operator acceptance |
| T26 | Clear/explicit_unclassified initial и update | Явный manual intent; assignment absent, positive continuity, no delete |
| T27 | Source удалён после issuance / до write / после write | Safe not-found либо applied/missing ack, без orphan leak/rollback claim |
| T28 | PATCH/DELETE после последней проверки, A→B→A | Option A limitation demonstrable; никогда atomic claim |
| T29 | Missing/mismatched validator/index, warn/partial/sparse/DDL change | Unavailable, без repair/auto create; operational exclusion не объявлять atomic |
| T30 | WRITE off, READ on; WRITE on, READ off; missing issuer vs verify-only keys | Exact gate matrix; GET unchanged, readonly recovery отдельно |
| T31 | Account deleted / no status field / concurrent erasure / reused IDs | Выбранная existence policy, lifecycle assumptions и ограничения явны |
| T32 | Cross-site/form/text request, allowed/missing/null Origin, preflight | JSON/auth/Origin rules; CORS не заменяет server denial; cookie migration blocked |
| T33 | XSS-like strings в title/comment, JWT/proof captures, error injection | Plain escaped rendering; no facts/proof/digests/private errors в logs/APM/snapshots |
| T34 | Header/cache/304/service-worker/bfcache behavior | no-store на успех/ошибки; no stale confirmation/resumed apply |
| T35 | Unmount/refresh/logout при in-flight apply, abort no-op | Старые results не попадают в новую generation; server outcome не приравнен rollback |
| T36 | Proof reissued из save-time current source / confirmed:true shortcut | Архитектурно невозможно в handlers; proof issuer не вызывается из apply |
| T37 | Suggestions/recurrence/local provisional review | Не authority/revision/manual confirmation; no automatic write |
| T38 | Любой failed verification / reconcile branch | Zero classification/source writes, no repair; full financial BSON unchanged |
| T39 | Real Mongo teardown/parent hooks и secret-safe TAP | Existing generated DB guards, drop/empty/disconnect/log/listener cleanup; parent failures не green |

## 11. Решения владельца до реализации

| ID | Предложение на утверждение | Статус / что блокирует |
| --- | --- | --- |
| H1 | A: purpose-specific AES-256-GCM; B/C отклонить для v1 | PENDING; механизм proof не выбран фактом создания RFC |
| H2 | Prepare/apply + отдельный readonly reconcile, exact DTO/status/version contracts | PENDING; новых endpoints пока нет |
| H3 | 300s admission TTL, future-iat skew 30s, bounded 24h readonly recovery | PENDING; expiry не commit deadline |
| H4 | Keyring/era, separate secrets, rotation/nonce budget/fleet accounting, time/rollback policy | PENDING; никаких ключей/secret config не создавать сейчас |
| H5 | Exact credential binding + UI-only lifecycle protection; принять same-token ABA/logout residual risk либо сначала отдельный server-session protocol | PENDING; не выдавать local generation за backend guarantee |
| H6 | Для новых routes требовать exp + account existence; exact bearer binding также для readonly recovery | PENDING; existing auth/GET не меняются |
| H7 | Полная authorized facts projection, round-trip amount/UTC/comment tags и limits; memory-only recovery trade-off | PENDING; preview/kopecks snapshots нельзя подключить напрямую |
| H8 | Stable-only UI integration, endpoint parser/error/cache/Origin/rate-limit design, proposed HTTP mapping | PENDING; отдельный implementation PR после approval |
| H9 | Write gate/drain/DDL exclusion, migration/backup/erasure/topology/key readiness и rollout | PENDING operational approval; D1–D10 уже approved, readiness не подтверждена |
| H10 | Реализация и выполнение T01–T39 на synthetic fixtures с сохранением regressions | PENDING implementation authorization; этот PR только docs |

Выбор B, durable ledger/single-use или строгой серверной session revocation потребует
нового storage/auth/lifecycle согласования, а не молчаливого расширения D1–D10.
Ни один H-пункт не считается утверждённым через merge старых C3.1/C3.3a решений.

## 12. Проверка этого RFC

Контракты сверены с закреплёнными backend/frontend исходниками из §1. Локально
разрешён и выполняется только `git diff --check`; npm/install/typecheck/build/tests,
proof crypto experiments, DB/service startup и production inspection не требуются
и не выполняются. Если существующий GitHub Actions запускается на Draft PR,
его фактический результат проверяется отдельно; green CI не проверяет ещё не
реализованные криптографические/UI/HTTP гарантии T01–T39.
