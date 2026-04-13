CREATE TABLE IF NOT EXISTS ulda_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sign BLOB NOT NULL,
  data BLOB NOT NULL,
  create_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  update_time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
