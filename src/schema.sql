-- nodemode per-workspace DO SQLite schema
-- Each Workspace Durable Object instance creates these tables
-- in its embedded SQLite database on first access.

-- Filesystem index (R2 is flat key-value, this gives us directory semantics)
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mode INTEGER NOT NULL DEFAULT 0o644,
  mtime INTEGER NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_parent ON files(
  substr(path, 1, length(path) - length(replace(path, '/', '')) - length(substr(path, length(path) - instr(reverse(path), '/') + 2)))
);

-- File content cache (hot files cached in SQLite for <1ms reads)
CREATE TABLE IF NOT EXISTS file_cache (
  path TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  cached_at INTEGER NOT NULL
);

-- Process state
CREATE TABLE IF NOT EXISTS processes (
  pid INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  stdout TEXT,
  stderr TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Workspace metadata
CREATE TABLE IF NOT EXISTS workspace_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '/',
  env TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Terminal output buffer (persists across DO hibernation)
CREATE TABLE IF NOT EXISTS terminal_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'stdin')),
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
