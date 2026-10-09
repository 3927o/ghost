CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  header TEXT NOT NULL CHECK (json_valid(header)),
  inherited_event_count INTEGER NOT NULL CHECK (inherited_event_count >= 0),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  generation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event TEXT NOT NULL CHECK (json_valid(event)),
  PRIMARY KEY (session_id, seq)
);

-- A live handle owns a lease, independent of the short append transactions.
CREATE TABLE IF NOT EXISTS session_writers (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  token TEXT NOT NULL,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
