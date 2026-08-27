CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  avatar TEXT DEFAULT '😀',
  email TEXT DEFAULT '无',
  passHash TEXT NOT NULL,
  passSalt TEXT NOT NULL,
  joinedGroups TEXT DEFAULT '[]',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '💬',
  owner TEXT NOT NULL,
  members TEXT DEFAULT '[]',
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  groupCode TEXT NOT NULL,
  senderPhone TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  content TEXT,
  ts INTEGER NOT NULL,
  readBy TEXT DEFAULT '[]',
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(groupCode, ts);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presence_global (
  phone TEXT PRIMARY KEY,
  nickname TEXT,
  avatar TEXT,
  lastSeen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presence_group (
  groupCode TEXT NOT NULL,
  phone TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  lastSeen INTEGER NOT NULL,
  PRIMARY KEY (groupCode, phone)
);

CREATE TABLE IF NOT EXISTS locations (
  groupCode TEXT NOT NULL,
  phone TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  lastSeen INTEGER NOT NULL,
  PRIMARY KEY (groupCode, phone)
);

CREATE TABLE IF NOT EXISTS calls (
  groupCode TEXT PRIMARY KEY,
  type TEXT DEFAULT 'voice',
  startedBy TEXT,
  startedAt INTEGER,
  participants TEXT DEFAULT '[]',
  lastSeen INTEGER
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  rating INTEGER,
  content TEXT,
  ts INTEGER NOT NULL,
  replies TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS media (
  key TEXT PRIMARY KEY,
  mimeType TEXT NOT NULL,
  data TEXT NOT NULL,
  uploadedBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_reads (
  groupCode TEXT NOT NULL,
  phone TEXT NOT NULL,
  lastReadTs INTEGER NOT NULL,
  PRIMARY KEY (groupCode, phone)
);

CREATE TABLE IF NOT EXISTS near_sessions (
  code TEXT PRIMARY KEY,
  createdBy TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS near_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  peer TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_near_signal ON near_signals(code, peer);
