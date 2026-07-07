---
title: "Миграция с Supabase на самостоятельный Postgres + docker-compose"
type: "refactor"
created: "2026-07-07"
status: "done"
review_loop_iteration: 0
baseline_commit: "4ee5253"
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Сервис полностью завязан на облачный Supabase (PostgREST-клиент, Auth, Storage, RPC). Нужна независимость: обычный Postgres, поднимаемый рядом с сервером через docker-compose.

**Approach:** Заменить обвязку, сохранив контракты: собственная таблица `users` + `Bun.password` вместо Supabase Auth, проверка Google id_token по JWKS на сервере, таблица `meal_exports` вместо Storage-бакета, `Bun.sql` вместо `@supabase/supabase-js`. Сигнатуры экспортируемых функций data-слоя не меняются — остальной код не трогаем.

## Boundaries & Constraints

**Always:**

- Сигнатуры и семантика экспортов `src/supabase.ts` (переименовать в `src/db.ts`), `src/export.ts` сохраняются; вызывающий код меняет только импорты.
- Все timestamps — `timestamptz` (UTC), наружу отдавать ISO-строки как сейчас (драйвер может вернуть `Date` — нормализовать).
- Partial unique indexes для idempotency `(user_id, idempotency_key) where idempotency_key is not null` обязательны; `consumeAuthCode`/`consumeRefreshToken` — атомарный `delete … returning`.
- Google id_token: серверная проверка подписи (JWKS), `iss`, `aud === GOOGLE_CLIENT_ID`, `exp`, `nonce`: сравнивать `claims.nonce === sha256hex(rawNonce)` (в Google уходит хеш). Линковать по email только при `email_verified === true`.
- UUID пользователей сохраняются (перенос из `auth.users.id`), `gen_random_uuid()` в схеме.
- `docker-compose.yml`: сервисы `app` + `postgres` (официальный образ, мажорная версия зафиксирована), named volume, healthcheck `pg_isready`, `app` стартует после healthy db.

**Ask First:**

- Добавление зависимостей помимо `jose` (для JWKS/JWT).
- Любое изменение контрактов MCP-инструментов или OAuth-эндпоинтов.
- Принудительная переавторизация всех клиентов (если решим не переносить `oauth_tokens`).

**Never:**

- Не переносить RLS/роли (`anon`, `authenticated`, `service_role`) — сервер единственная точка доступа, фильтрация по `user_id` в запросах.
- Не менять timezone-логику (`tz.ts`) и бизнес-логику инструментов.
- Не строить S3-совместимый storage и generic-фреймворк миграций.

## I/O & Edge-Case Matrix

| Scenario                                   | Input / State                          | Expected Output / Behavior                            | Error Handling          |
| ------------------------------------------ | -------------------------------------- | ----------------------------------------------------- | ----------------------- |
| Логин импортированного юзера               | email + пароль, bcrypt-хеш из Supabase | `Bun.password.verify` принимает bcrypt → вход успешен | сообщение как сейчас    |
| Google-вход нового юзера                   | валидный id_token, email_verified      | создаётся `users`-запись с `google_sub`               | renderError как сейчас  |
| Google id_token с чужим nonce              | `claims.nonce !== sha256hex(rawNonce)` | вход отклонён                                         | "Google sign-in failed" |
| Повтор insertMeal (тот же idempotency key) | конкурентный retry, 23505              | вернуть существующую запись, `deduplicated: true`     | как сейчас              |
| Скачивание экспорта по истёкшему токену    | `expires_at < now()`                   | 404                                                   | text/plain 404          |
| Первый старт compose                       | пустой volume                          | init-SQL применяется, сервер стартует                 | app ждёт healthy db     |

</frozen-after-approval>

## Code Map

- `src/supabase.ts` → `src/db.ts` -- весь data-слой: auth, CRUD, токены, RPC → переписать на `Bun.sql`
- `src/export.ts` -- Storage-бакет → таблица `meal_exports` + sweep через `delete where expires_at < now()`
- `src/analytics.ts`, `src/foods.ts`, `src/middleware.ts`, `src/oauth.ts`, `src/mcp.ts`, `src/index.ts` -- только импорты/вызовы
- `supabase/migrations/*.sql` -- источник схемы → консолидировать в `db/init/001_schema.sql`
- `Dockerfile` -- уже есть; `docker-compose.yml` -- создать
- `src/index.ts` -- новый роут `GET /exports/:token/meals.csv`; `getLandingStats` → aggregate SQL

## Tasks & Acceptance

**Execution:**

- [x] `db/init/001_schema.sql` -- консолидированная схема: `users` (id uuid PK, email unique lower-case, password_hash null, google_sub unique null, email_verified, timestamps), все public-таблицы с FK на `users(id)` on delete cascade, `meal_exports(token PK, user_id FK, csv_text, expires_at)`, индексы и partial unique для idempotency; без RLS/grants/storage
- [x] `package.json` -- убрать `@supabase/supabase-js`, добавить `jose`; env: `DATABASE_URL` вместо `SUPABASE_URL`/`SUPABASE_SECRET_KEY`
- [x] `src/db.ts` -- переписать data-слой на `Bun.sql`: тот же набор экспортов; auth-функции через `users` + `Bun.password` (argon2id для новых, verify принимает bcrypt); `signInWithGoogleIdToken(idToken, rawNonce)` — проверка через `jose` + JWKS Google; `deleteAllUserData` включает `meal_exports` и `users`; `getLandingStats` — прямой aggregate SQL; нормализация Date→ISO
- [x] `src/export.ts` -- upload/signedUrl/sweep → insert в `meal_exports`, URL `/exports/:token/meals.csv`, sweep — один DELETE
- [x] `src/index.ts` -- роут `GET /exports/:token/meals.csv` (проверка token+expiry, text/csv); обновить импорты
- [x] `src/analytics.ts`, `src/foods.ts`, `src/middleware.ts`, `src/oauth.ts`, `src/mcp.ts` -- обновить импорты на `db.ts`
- [x] `docker-compose.yml` -- app (build .) + postgres: volume, healthcheck, `db/init` в `/docker-entrypoint-initdb.d`, env через `.env`
- [x] `docs/migrate-from-supabase.md` -- runbook: freeze writes, dump `public.*` + `auth.users`/`auth.identities`, перенос users с теми же UUID, перенос public-таблиц и `oauth_tokens`/`refresh_tokens`, `auth_codes`/Storage не переносить
- [x] `src/db.test.ts` -- тесты edge-cases из матрицы (nonce, bcrypt-verify, idempotency, expiry)
- [x] `README.md`, `CLAUDE.md`, `public/privacy.html` -- убрать упоминания Supabase, задокументировать compose-запуск

**Acceptance Criteria:**

- Given чистая машина с docker, when `docker compose up`, then сервер и Postgres поднимаются, `/health` отвечает ok, MCP-инструменты работают end-to-end.
- Given юзер с bcrypt-хешем из Supabase-дампа, when вход по паролю, then успех без сброса пароля.
- Given `bun test`, when прогон, then все тесты зелёные без сетевых обращений к Supabase.
- Given экспорт CSV, when скачивание по ссылке в течение 60 мин, then файл отдаётся; после — 404, запись выметена sweep'ом.

## Design Notes

Rate-limit на логин (Supabase его давал бесплатно): переиспользовать существующий `rateLimit` из `middleware.ts` на `/approve` и Google callback. In-memory OAuth-сессии остаются — один контейнер app, как сейчас.

## Verification

**Commands:**

- `bun test` -- expected: все тесты проходят
- `docker compose up -d && curl -f localhost:8080/health` -- expected: `ok`
- `docker compose exec postgres pg_isready` -- expected: accepting connections

**Manual checks (if no CLI):**

- Полный OAuth-флоу (email + Google) в браузере против compose-стека; лог еды через MCP-клиент; экспорт CSV и скачивание по ссылке.

## Suggested Review Order

**Схема и точка входа**

- Единая консолидированная схема: users вместо auth.users, без RLS/ролей
  [`001_schema.sql:9`](../../db/init/001_schema.sql#L9)

- Partial unique index — фундамент идемпотентности retry
  [`001_schema.sql:72`](../../db/init/001_schema.sql#L72)

**Auth (самое security-чувствительное)**

- Google-линковка: verified-only, guard от чужого sub, гонка через 23505/re-select
  [`db.ts:200`](../../src/db.ts#L200)

- Вход: bcrypt+argon2id, dummy-hash против тайминг-энумерации
  [`db.ts:64`](../../src/db.ts#L64)

- Регистрация: серверная валидация email, generic-ошибки наружу
  [`db.ts:67`](../../src/db.ts#L67)

- Двухоконный rate-limit логина (IP + email), XFF-допущение задокументировано
  [`oauth.ts:59`](../../src/oauth.ts#L59)

**Data-слой на Bun.sql**

- Тестовый шов вместо реальной БД в bun test
  [`db.ts:23`](../../src/db.ts#L23)

- Идемпотентный insert: lookup → insert → 23505 → re-select
  [`db.ts:323`](../../src/db.ts#L323)

- Каскадное удаление аккаунта одной транзакцией
  [`db.ts:936`](../../src/db.ts#L936)

**Экспорт без Storage**

- Замена бакета таблицей: транзакционный delete+insert, токен-URL
  [`db.ts:1078`](../../src/db.ts#L1078)

- Fail-fast валидация BASE_URL до обращений к БД
  [`export.ts:65`](../../src/export.ts#L65)

- Публичный роут скачивания: токен+expiry → text/csv, иначе 404
  [`index.ts:124`](../../src/index.ts#L124)

**Инфраструктура**

- app+postgres, initdb.d-схема, TCP-healthcheck против false-healthy при инициализации
  [`docker-compose.yml:31`](../../docker-compose.yml#L31)

- Runbook переноса данных с сохранением UUID пользователей
  [`migrate-from-supabase.md:1`](../../docs/migrate-from-supabase.md#L1)

**Периферия**

- 40 тестов data-слоя без БД (nonce, bcrypt, idempotency, expiry, транзакции)
  [`db.test.ts:1`](../../src/db.test.ts#L1)

- Стартовое предупреждение об незаданном BASE_URL
  [`index.ts:238`](../../src/index.ts#L238)
