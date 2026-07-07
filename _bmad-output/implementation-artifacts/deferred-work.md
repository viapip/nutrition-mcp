# Deferred Work

- source_spec: `spec-migrate-supabase-to-postgres.md`
  summary: Линковка Google к существующему password-аккаунту не инвалидирует пароль — окно pre-account-takeover (атакующий заранее регистрирует чужой email).
  evidence: Blind Hunter #1; signup не подтверждает владение почтой, byEmail-линковка оставляет password_hash атакующего валидным. Поведение портировано из Supabase (auto-confirm) — не регресс, но требует решения: обнулять password_hash при линковке или вводить подтверждение email.
  resolution: закрыто после повторного HIGH-флага от автоматического ревью коммита — password_hash обнуляется при линковке (fix(auth)-коммит вслед за 0173fc8); полноценная email-верификация по-прежнему возможное будущее улучшение.

- source_spec: `spec-migrate-supabase-to-postgres.md`
  summary: Rate-limit по IP опирается на спуфабельный X-Forwarded-For; credential stuffing по многим email не ограничен.
  evidence: Blind Hunter #2 + автоматическое security-ревью. Email-bucket закрывает перебор одного аккаунта; для полного решения нужен TRUSTED_PROXIES-механизм в middleware.ts (тот же паттерн у /mcp-лимитера и maskIp — pre-existing).

- source_spec: `spec-migrate-supabase-to-postgres.md`
  summary: После delete_account в tool_analytics остаётся одна строка с user_id (аналитика самого вызова).
  evidence: Blind Hunter #10; осознанное решение (коммент в 001_schema.sql), но для «удалить все данные» стоит скипать персист аналитики этого вызова.

- source_spec: `spec-migrate-supabase-to-postgres.md`
  summary: csvEscape не защищает от CSV/formula-injection (=, +, -, @ в начале значения).
  evidence: Blind Hunter pre-existing; экспорт открывается в Excel/Sheets, значения приходят из пользовательского ввода. Не менялось миграцией.

- source_spec: `spec-migrate-supabase-to-postgres.md`
  summary: Флоу /approve (try signIn → catch signUp, текст «User already registered») позволяет энумерацию зарегистрированных email.
  evidence: Blind Hunter pre-existing; поведение сохранено с Supabase-времён. Вместе с ним закрыть и тайминг-канал signInUser, если займёмся.
