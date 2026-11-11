-- Website Assistant on Cloudflare D1: every table of the self-hosted Postgres schema (app/db/models.py).
--
-- Conversions: JSONB -> TEXT holding JSON, booleans -> INTEGER 0/1, timestamps -> ISO-8601 UTC TEXT
-- ("2026-11-11T10:00:00.000Z", the format of Date.toISOString(), so text comparison is time order).
-- chunks has no embedding column: each chunk's vector lives in Vectorize (id = String(chunks.id),
-- namespace "c{clients.id}"). Keyword search uses the FTS5 table chunks_fts.

-- ------------------------------------------------------------------ settings
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------ AI models
CREATE TABLE ai_models (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  base_url           TEXT,
  model_name         TEXT NOT NULL,
  api_key_encrypted  TEXT,
  temperature        REAL NOT NULL DEFAULT 0.2,
  max_tokens         INTEGER NOT NULL DEFAULT 600,
  timeout_seconds    INTEGER NOT NULL DEFAULT 60,
  cost_input_per_m   REAL,
  cost_output_per_m  REAL,
  last_test_ok       INTEGER,
  last_test_at       TEXT,
  last_test_message  TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------ clients
CREATE TABLE clients (
  id                   INTEGER PRIMARY KEY,
  client_id            TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  website_url          TEXT,
  allowed_domains      TEXT NOT NULL DEFAULT '[]',
  branding             TEXT NOT NULL DEFAULT '{}',
  crawl_settings       TEXT NOT NULL DEFAULT '{}',
  document_settings    TEXT NOT NULL DEFAULT '{}',
  ai_model_id          INTEGER REFERENCES ai_models(id) ON DELETE SET NULL,
  active               INTEGER NOT NULL DEFAULT 1,
  last_crawl_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  api_actions_enabled  INTEGER NOT NULL DEFAULT 0,
  api_settings         TEXT NOT NULL DEFAULT '{}'
);

-- ------------------------------------------------------------------ users
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'client_admin',
  active           INTEGER NOT NULL DEFAULT 1,
  session_version  INTEGER NOT NULL DEFAULT 1,
  last_login_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE user_clients (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);

-- ------------------------------------------------------------------ API actions
CREATE TABLE client_actions (
  id                     INTEGER PRIMARY KEY,
  client_id              INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  method                 TEXT NOT NULL DEFAULT 'GET',
  path                   TEXT NOT NULL,
  parameters             TEXT NOT NULL DEFAULT '[]',
  requires_confirmation  INTEGER NOT NULL DEFAULT 0,
  enabled                INTEGER NOT NULL DEFAULT 1,
  response_hint          TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_client_actions_client_name UNIQUE (client_id, name)
);
CREATE INDEX ix_client_actions_client_id ON client_actions (client_id);

-- ------------------------------------------------------------------ analytics
CREATE TABLE questions (
  id                   INTEGER PRIMARY KEY,
  client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id           TEXT NOT NULL,
  channel              TEXT NOT NULL DEFAULT 'widget',
  question             TEXT NOT NULL,
  question_normalized  TEXT NOT NULL,
  answer               TEXT NOT NULL DEFAULT '',
  sources              TEXT NOT NULL DEFAULT '[]',
  answered             INTEGER NOT NULL DEFAULT 0,
  top_score            REAL,
  language             TEXT,
  model_id             INTEGER REFERENCES ai_models(id) ON DELETE SET NULL,
  model_name           TEXT,
  used_fallback        INTEGER NOT NULL DEFAULT 0,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost                 REAL NOT NULL DEFAULT 0,
  response_ms          INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  actions_used         TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_questions_client_created ON questions (client_id, created_at);
CREATE INDEX ix_questions_session ON questions (client_id, session_id, created_at);

CREATE TABLE action_calls (
  id               INTEGER PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  question_id      INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  session_id       TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'widget',
  action_name      TEXT NOT NULL,
  request_summary  TEXT NOT NULL DEFAULT '{}',
  status_code      INTEGER,
  ok               INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  response_ms      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ix_action_calls_client_created ON action_calls (client_id, created_at);

CREATE TABLE action_sessions (
  client_id           INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL,
  vault_encrypted     TEXT,
  pending_encrypted   TEXT,
  pending_expires_at  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (client_id, session_id)
);

-- ------------------------------------------------------------------ content
CREATE TABLE pages (
  id            INTEGER PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  content       TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  crawled_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT uq_pages_client_url UNIQUE (client_id, url)
);
CREATE INDEX ix_pages_client_id ON pages (client_id);

CREATE TABLE documents (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  path            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  file_hash       TEXT,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  error           TEXT,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  uploaded_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  indexed_at      TEXT,
  -- Cloudflare additions: the uploaded file in R2, and its extracted text (so re-indexing doesn't
  -- re-parse). Text too large for a D1 row is stored in R2 under text_r2_key instead.
  r2_key          TEXT,
  extracted_text  TEXT,
  text_r2_key     TEXT,
  text_hash       TEXT,
  CONSTRAINT uq_documents_client_source_path UNIQUE (client_id, source, path)
);
CREATE INDEX ix_documents_client_id ON documents (client_id);

CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: it is also the Vectorize vector id
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source        TEXT NOT NULL,
  page_id       INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  document_id   INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL DEFAULT 0,
  title         TEXT,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- 1 while a large source is being re-indexed across several invocations: search ignores these
  -- rows until the whole source is ready, then one batch swaps them in (atomic for search).
  pending       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_chunks_client_id ON chunks (client_id);
CREATE INDEX ix_chunks_page_id ON chunks (page_id);
CREATE INDEX ix_chunks_document_id ON chunks (document_id);

-- Keyword search (replaces Postgres full-text search). remove_diacritics 0 and the M* category keep
-- combining marks (Malayalam/Hindi vowel signs) inside their words, like the Python words() split.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  title, content,
  content = 'chunks', content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 0 categories 'L* N* M* Co'"
);
CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (rowid, title, content) VALUES (new.id, coalesce(new.title, ''), new.content);
END;
CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, title, content) VALUES ('delete', old.id, coalesce(old.title, ''), old.content);
END;
CREATE TRIGGER chunks_fts_au AFTER UPDATE OF title, content ON chunks BEGIN
  INSERT INTO chunks_fts (chunks_fts, rowid, title, content) VALUES ('delete', old.id, coalesce(old.title, ''), old.content);
  INSERT INTO chunks_fts (rowid, title, content) VALUES (new.id, coalesce(new.title, ''), new.content);
END;

-- ------------------------------------------------------------------ jobs
CREATE TABLE jobs (
  id                INTEGER PRIMARY KEY,
  type              TEXT NOT NULL,
  client_id         INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'queued',
  progress          INTEGER NOT NULL DEFAULT 0,
  progress_text     TEXT,
  payload           TEXT NOT NULL DEFAULT '{}',
  result            TEXT,
  log               TEXT NOT NULL DEFAULT '',
  error             TEXT,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  triggered_by      TEXT NOT NULL DEFAULT 'user',
  created_by_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at        TEXT,
  finished_at       TEXT,
  heartbeat_at      TEXT,
  -- Cloudflare addition: a job runs as small resumable steps; the step currently executing holds
  -- this lease so two invocations never run the same job at once.
  lock_until        TEXT
);
CREATE INDEX ix_jobs_status_created ON jobs (status, created_at);
CREATE INDEX ix_jobs_client_id ON jobs (client_id);

-- A crawl's frontier (URLs to fetch, and what happened to each), so a crawl resumes across invocations.
-- state: 0 queued, 1 fetched (seen), 2 gone (404/410), 3 done without content (error, non-HTML, off-site)
CREATE TABLE crawl_frontier (
  job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url     TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  state   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, url)
);
CREATE INDEX ix_crawl_frontier_next ON crawl_frontier (job_id, state, seq);

-- ------------------------------------------------------------------ rate limits
CREATE TABLE rate_limits (
  key           TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
