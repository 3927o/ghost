-- Current development schema. No version upgrades or legacy imports.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  logical_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, logical_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  request_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
  text TEXT NOT NULL DEFAULT '',
  error TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  owner_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_conversation ON runs(conversation_id) WHERE status = 'running';
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  error INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, role)
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
CREATE TABLE IF NOT EXISTS run_outbox (
  run_id TEXT PRIMARY KEY REFERENCES runs(id)
);
