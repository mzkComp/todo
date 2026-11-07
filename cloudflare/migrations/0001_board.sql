-- Same board tables as core/store.mjs. D1 migrations are managed by Wrangler.

  CREATE TABLE sections (id TEXT PRIMARY KEY, title TEXT NOT NULL, sub TEXT, note TEXT, hidden INTEGER, position REAL NOT NULL);
  CREATE TABLE cards (id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES sections(id), title TEXT NOT NULL, note TEXT,
    plain INTEGER, position REAL NOT NULL);
  CREATE TABLE items (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), title TEXT NOT NULL, note TEXT,
    status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'agent', 'waiting', 'done', 'dropped')), position REAL NOT NULL,
    created_at TEXT, updated_at TEXT, done_at TEXT, due TEXT, reason TEXT, waiting_on TEXT,
    repeat_days TEXT, repeat_time TEXT, -- repeat_days: a JSON array of weekdays
    agent_where TEXT, agent_note TEXT, agent_since TEXT, agent_last_seen TEXT,
    source TEXT); -- JSON: where a synced item came from (canvas/merge.mjs)
  CREATE TABLE check_ins (item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, day TEXT NOT NULL, PRIMARY KEY (item_id, day));
  CREATE TABLE places (name TEXT PRIMARY KEY, last_used TEXT, uses INTEGER NOT NULL, added_at TEXT);
  CREATE TABLE log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, entry TEXT NOT NULL); -- entry: JSON of the rest
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- value: JSON
  CREATE INDEX cards_by_section ON cards (section_id);
  CREATE INDEX items_by_card ON items (card_id);

-- Every mutation checks this revision before changing any rows.
INSERT INTO meta (key, value) VALUES ('rev', '0');
CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL);
CREATE INDEX login_attempts_by_window ON login_attempts (window_start);
