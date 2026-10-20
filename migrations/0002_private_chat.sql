CREATE TABLE IF NOT EXISTS chat_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  allow_files INTEGER NOT NULL DEFAULT 0,
  allow_extensions TEXT NOT NULL DEFAULT '',
  deny_extensions TEXT NOT NULL DEFAULT 'exe,com,bat,cmd,msi,js,vbs,ps1,sh,jar,scr',
  max_file_bytes INTEGER NOT NULL DEFAULT 10485760,
  message_interval_ms INTEGER NOT NULL DEFAULT 1000,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO chat_settings (id, updated_at) VALUES (1, unixepoch());
