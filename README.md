# Budget Calculator API

![Digit Budget Calculator](https://img.shields.io/github/license/mkozhevnikov2323/digit-budget-calculator-api)
![Node Version](https://img.shields.io/badge/node-%3E=18.0.0-green)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)

RESTful API для управления личными доходами, расходами и финансовыми категориями. Предназначен для backend-части финансового приложения с авторизацией, кастомными и дефолтными категориями, гибкой аналитикой и защитой пользовательских данных.

---

## Основные возможности

- Аутентификация и авторизация JWT
- Управление доходами пользователя (CRUD)
- Управление расходами пользователя (CRUD)
- Работа с категориями и получателями расходов
  - Дефолтные и пользовательские категории
  - Связь расходов с категориями и получателями
- Источники дохода
  - Предустановленные и кастомные источники
- Аналитика баланса
  - Подсчёт баланса за период
- Логи ошибок и запросов (Winston + express-winston)
- Валидация данных (Joi + Celebrate)
- Глобальная обработка ошибок
- Поддержка CORS

---

## Технологии

- [Node.js](https://nodejs.org/)
- [Express 5](https://expressjs.com/)
- [MongoDB + Mongoose](https://mongoosejs.com/)
- [JWT](https://jwt.io/)
- [Joi](https://joi.dev/)
- [Winston](https://github.com/winstonjs/winston)
- [Nodemon](https://nodemon.io/) + [tsx](https://tsx.is/) для разработки

---

## Требования

- Node.js >= 18
- MongoDB >= 4

---

## Быстрый старт

1. Клонируйте репозиторий:

`git clone https://github.com/mkozhevnikov2323/digit-budget-calculator-api.git`
`cd digit-budget-calculator-api`

2. Установите зависимости:

`npm install`

3. Создайте файл окружения `.env` (пример:):

`PORT=3000`
`JWT_SECRET=your_jwt_secret`
`MONGODB_URI=mongodb://localhost:27017/budget`

4. Запустите сервер (dev-режим):

`npm run dev`

---

## Постепенная миграция на TypeScript (B1)

Миграция выполняется небольшими группами модулей. Пока JavaScript и TypeScript
сосуществуют: `allowJs: true`, `checkJs: false`, строгий режим для нового
TypeScript-кода. Формат модулей остаётся CommonJS; существующие `.js` в B1
не переводятся на TypeScript.

- `npm run dev` запускает TypeScript entry point через nodemon + tsx (см. B2b ниже).
- `npm run typecheck` выполняет `tsc --noEmit -p tsconfig.json` без генерации файлов.
- `npm run build` выполняет `tsc -p tsconfig.json` и помещает результат только
  в игнорируемый Git каталог `dist/`, включая `dist/server.js` и прежние
  каталоги контроллеров, маршрутов, моделей, middleware и обработчиков ошибок.

Успешная компиляция пока не означает типобезопасность существующего JavaScript:
`checkJs` отключён на переходный период. Она также не доказывает корректность
runtime, авторизации или финансовой логики. Тестового framework и тестовой
команды на этапе B1 ещё нет.

Правила архитектуры, безопасности финансовых данных, миграции и работы агентов
описаны в корневом [AGENTS.md](./AGENTS.md). GitHub Actions проверяет PR в `main`
на Node.js 22: `npm ci`, typecheck, build и наличие `dist/server.js`.
Компиляторные проверки не запускают сервер и не требуют MongoDB или секретов.

Следующие шаги миграции рассматриваются отдельно. B1 не добавляет
production start script или deployment-конфигурацию. `server.ts` подключает
MongoDB и открывает HTTP listener при выполнении; не импортируйте и не запускайте
его или `dist/server.js` для проверки сборки.

Известные расхождения прежней документации с текущей реализацией: пример выше
содержит `MONGODB_URI`, однако `server.ts` читает `DATA_BASE_URL` при
`NODE_ENV=production`, иначе `DATA_BASE_URL_LOCAL` с локальным fallback.
Путь категорий в `routes/index.js` — `/categories`, а ниже указан
`/expense-categories`. Проверка JWT читает `JWT_SECRET` только в production.
Эти расхождения зафиксированы; имена переменных и runtime-конфигурация в B1
не изменяются.

---

## Приложение и bootstrap (B2a/B2b)

`app.ts` создаёт и экспортирует настроенное Express-приложение: body parsers,
логгеры, CORS, маршруты и обработчики ошибок в прежнем порядке. Он не вызывает
`mongoose.connect` и не открывает HTTP listener. Импорт маршрутов по-прежнему
создаёт файловые логгеры и включает существующий вызов dotenv в контроллере.

`server.ts` загружает dotenv до приложения, выбирает прежний MongoDB URL,
вызывает подключение и запускает listener. Порядок и обработка результата
подключения не переработаны: ожидание успешного подключения перед listen
не добавлено. `npm run dev` теперь выполняет TypeScript entry point (см. ниже).

После `npm run build` команда `npm run test:smoke` запускает встроенный Node.js
test runner и импортирует именно `dist/app.js`. Тесты используют
настоящие маршруты и middleware, временный каталог для логов/dotenv и
эфемерные порты только на `127.0.0.1`. Они проверяют импорт без подключения и
listener, запуск/закрытие, ответы без авторизации, валидацию публичных auth-запросов,
JSON/urlencoded parsing и CORS. Обращения к MongoDB и запросы к БД заблокированы.
Созданные listener и логгеры закрываются; `server.ts` и `dist/server.js` тесты
не импортируют. Без предварительной сборки `test:smoke` не готовит dist сам.

CI на Node.js 22 выполняет `npm ci`, typecheck, build, smoke-тесты и проверку
`dist/app.js` / `dist/server.js`. Compiled bootstrap не запускается.
Контроллеры, маршруты и модели остаются JavaScript;
JWT middleware переведён в `auth.ts` на этапе B3b,
слой errors — на TypeScript в B3a (см. ниже).
`allowJs: true` и `checkJs: false` сохранены. Authenticated CRUD, реальная
авторизация владельцев и DB bootstrap этими smoke-тестами не проверены.

---

## TypeScript entry points (B2b)

`app.ts` и `server.ts` заменяют исходные `.js` без параллельных копий.
`app.ts` использует типы Express 5 и `export = app`: CommonJS-потребитель
получает Express-функцию через `require('./dist/app.js')`, без `.default`.
Последовательные `import = require` в bootstrap сохраняют выполнение dotenv
до импорта приложения; добавленная URI type assertion не меняет runtime-значение
и не вводит обязательную валидацию env.

Публичная команда разработки — `npm run dev`:

```sh
nodemon --watch . --ext ts,js,json --ignore dist/ --exec tsx server.ts
```

Существующий nodemon сохранён: он отслеживает новые TS и legacy JS, включая
изменения импортированных модулей; `dist/` исключён от перезапусков. Файлы логов
не входят в отслеживаемые расширения, node_modules/.git исключены по умолчанию.
Добавлены только dev-зависимости `tsx` и `@types/express` версии 5.

Сборка остаётся ES2022/CommonJS со strict mode и выводом в `dist/`.
`package.json.main` указывает на `dist/server.js`, потому что исходный
`server.js` удалён. Перед использованием compiled entry нужна сборка; отдельный
production start script или deployment не добавляются.

Слой errors мигрирован отдельно в B3a; типизация middleware/auth требует
отдельного этапа B3b (см. ниже). B2b не меняет финансовые правила, JWT, owner checks,
HTTP-контракты или схемы БД.

---

## Строгий TypeScript для ошибок (B3a)

Четыре модуля `errors/authorizationError.ts`, `errors/forbiddenError.ts`,
`errors/notFoundError.ts` и `errors/globalErrorHandler.ts` заменяют исходные JS
без параллельных копий. `export =` сохраняет прямой CommonJS `require(...)`:
классы создаются без `.default`, пути legacy-потребителей не меняются.
Сборка создаёт соответствующие `dist/errors/*.js`; tsx разрешает исходные TS
из legacy JS в режиме разработки без изменения call sites.

Статусы 401/403/404, сообщения, `headersSent → next(err)` и прежняя семантика
`statusCode || 500` сохранены. Для 500 возвращается прежнее общее сообщение.
Узкая type assertion метаданных не требует `instanceof Error`, стирается при
сборке и не добавляет нормализацию, проверку статуса или защиту от null/undefined.
Порядок Express/Celebrate middleware не меняется.

После `npm run build` команда `npm run test:smoke` выполняет оба файла:
`tests/app-smoke.test.cjs` (прежние 14 HTTP smoke-тестов) и
`tests/error-contract.test.cjs` (контракты compiled классов и обработчика).
CI сохраняет порядок install → typecheck → build → test:smoke → artifacts.
Сборка перед тестами обязательна; тесты не запускают bootstrap или MongoDB.

Контроллеры, маршруты и модели остаются JavaScript с `checkJs: false`;
JWT/auth мигрирован в B3b, CORS/logger — в B3c.
Authenticated CRUD и реальные операции MongoDB не проверены.
B3b описан ниже; последующие этапы требуют отдельного архитектурного review.

---

## JWT middleware на TypeScript (B3b)

`middlewares/auth.ts` заменяет `auth.js`, использует Express 5 `RequestHandler`
и экспорт `export = auth`. Legacy маршруты продолжают получать функцию через
прежний `require('../middlewares/auth')` без `.default`; сборка создаёт
`dist/middlewares/auth.js`, исходный TS доступен через существующий tsx loader.
Команда nodemon + tsx и bootstrap не изменены.

`types/express.d.ts` добавляет только `Request.user?: unknown`. Тип не обещает
наличие объекта или валидного `_id`. Сохранены точный префикс `Bearer `, извлечение
через `replace`, выбор JWT-секрета, прямое присваивание payload и оба прежних
сообщения 401 с исходной пунктуацией. Узкая стираемая assertion на границе verify
не заменяет отсутствующий production `JWT_SECRET`: в этом случае проверка токена
завершается прежней ошибкой. Генерация токена и срок семь дней не менялись.

После обязательного `npm run build` команда `npm run test:smoke` явно запускает
три файла: прежние 14 app smoke, 21 error contract и новые auth contract tests.
JWT-тесты используют реальные sign/verify, синтетические payload/ключи,
фиксированные часы и последовательные проверки с восстановлением NODE_ENV и
JWT_SECRET. Секреты и токены не логируются. CI остаётся на Node.js 22 с прежним
порядком проверок и дополнительно проверяет артефакт `dist/middlewares/auth.js`.
Добавлена только dev-зависимость типов `@types/jsonwebtoken`.

Известные ограничения сохранены для отдельного security review: development
секрет остаётся прежним, подписанные строки и объекты без корректного `_id`
принимаются middleware. Успешная проверка JWT, валидация личности владельца и
проверка владения данными — три разных гарантии. Будущие owner/security contract
тесты должны проверять последние две отдельно. Это не полный аудит безопасности;
authenticated MongoDB CRUD и owner isolation здесь не проверены. Контроллеры,
маршруты и модели остаются unchecked JavaScript; остальные middleware мигрированы
в B3c (см. ниже). B4 требует отдельного архитектурного review.

---

## Общие middleware на TypeScript (B3c)

`middlewares/cors.ts` и `middlewares/logger.ts` заменяют исходные JS без
параллельных копий. Все shared middleware теперь strict TypeScript.
CORS экспортирует функцию через `export =`, logger — прежний объект
`{ requestLogger, errorLogger }`; CommonJS и tsx не требуют `.default`.
В `app.ts` named import заменён на `import = require` для совместимости с
типизированным объектом `export =`; обращения к свойствам и порядок не меняются.
Порядок parsers → request logger → CORS → routes → error logger → Celebrate →
global error handler сохранён. Типы Winston и express-winston встроены в пакеты;
новых зависимостей нет. Настройки компилятора и dev runner не менялись.

CORS сохраняет ровно два origin: `https://digit-budget-calculator.onrender.com`
и `http://localhost:5173`, без wildcard/нормализации/credentials headers.
DEFAULT_ALLOWED_METHODS читается при импорте. OPTIONS завершается до маршрутов;
неизвестный origin не получает allow-origin. При отсутствующих значениях
methods/request headers Express по-прежнему записывает строку `"undefined"`;
миграция не добавляет defaults или валидацию. Это отдельный вопрос конфигурации.

Логгеры создаются при импорте и используют прежние File transports `request.log`
и `error.log`, формат JSON и неизменённые express-winston options.
Security follow-up: defaults express-winston включают request headers/url/query
при пустом header blacklist. Возможна запись чувствительных заголовков/query и
метаданных ошибок; политику redaction необходимо согласовать отдельно. Миграция
не расширяет и не меняет логирование, не является полным аудитом его безопасности.

После `npm run build` запускайте `npm run test`: это alias сохранённой команды
`test:smoke` с явными пятью файлами. Прежние 57 тестов дополнены 14 CORS и 6 logging-тестами:
`tests/cors-contract.test.cjs` (точный allowlist, preflight, undefined headers,
module-time env и изоляция require cache) и `tests/logger-contract.test.cjs`
(CommonJS, реальные File transports, JSON-записи, делегирование и cleanup).
Логи создаются только во временном каталоге и удаляются после закрытия настоящих
файловых потоков. БД, сеть и listeners заблокированы в focused logger tests;
реальное приложение проверяется прежними isolated HTTP smoke tests.
CI Node.js 22: npm ci → typecheck → build → test → artifact verification,
включая `dist/middlewares/cors.js` и `dist/middlewares/logger.js`.

Контроллеры, маршруты и модели остаются JavaScript с `checkJs: false`.
Проверка подписи JWT недостаточна для подтверждения валидной личности владельца.
До live multiuser financial classification нужны отдельные contract/security
проверки backend authorization и ownership. Owner isolation и authenticated
MongoDB CRUD здесь не проверены. B4 и усиление JWT/ownership не начинаются
автоматически; требуется отдельное архитектурное review.

---

## Структура проекта

```
.
├── controllers # Логика обработки роутов
├── errors # TypeScript-классы ошибок и глобальный обработчик
├── middlewares # TypeScript: авторизация, CORS, логгер
├── models # Схемы данных Mongoose
├── routes # Маршруты API
├── app.ts # Конфигурация Express без подключения к БД и listener
├── server.ts # TypeScript bootstrap приложения
├── tests # Изолированные smoke-тесты на Node.js test runner
├── request.log # Файл логов запросов
├── error.log # Файл логов ошибок
└── README.md
```

---

## Основные эндпоинты

- `POST /auth/register` — регистрация пользователя
- `POST /auth/login` — вход пользователя
- `GET /users/me` — информация о текущем профиле
- `GET /incomes` — список доходов
- `POST /incomes` — добавить доход
- `GET /expenses` — список расходов
- `POST /expenses` — добавить расход
- `GET /balance` — расчёт баланса
- `GET /expense-categories` — список категорий расходов
- `GET /sources` — источники доходов

Полный список эндпоинтов — см. папку [`routes`](./routes)

---

## Best Practices

- Используются собственные классы ошибок (см. папку `errors`)
- Сущности разделены на дефолтные и пользовательские по разным моделям (`expenseCategoryDefault.js`, `expenseCategoryUser.js` и т.д.)
- Реализована строгая валидация входящих данных (`celebrate` + `joi`)
- Централизованный обработчик ошибок (`globalErrorHandler`)
- Все защищённые эндпоинты требуют JWT авторизации (см. `middlewares/auth.ts`)
- Запросы и ошибки логируются в файлы, а не только в консоль (`express-winston`)
- Проект структурирован по feature-style (контроллеры, модели и маршруты разделены по сущностям)

---

## Рекомендации по продакшну

- Используйте сложные значения `JWT_SECRET` и храните их вне исходного кода (например, в переменных окружения или vault)
- Подключайте MongoDB из безопасных подсетей
- Настраивайте CORS (см. `middlewares/cors.ts`) согласно вашим фронтам
- Логируйте ошибки в централизованный сервис (Sentry, Elastic и т.д.)
- Не забудьте убрать dev-зависимости в production-сборке

---

## Вклад и обратная связь

Пулл-реквесты и issue приветствуются! Оставляйте баги, предложения и пожелания в [issue tracker](https://github.com/mkozhevnikov2323/digit-budget-calculator-api/issues).

---

## Лицензия

ISC

---

Автор:  
_Maksim Olhovsky (mkozhevnikov23@gmail.com)_  
[GitHub](https://github.com/mkozhevnikov2323)

---
