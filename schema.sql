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

-- 扫码登录会话（二维码只含一次性随机 id，2 分钟过期）
CREATE TABLE IF NOT EXISTS qr_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  phone TEXT,
  login_token TEXT,
  expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- ============ 安全中心 ============
-- Passkey 凭据（只存公钥与计数器，私钥永不出认证器）
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  device TEXT DEFAULT '',
  created_at INTEGER,
  last_used INTEGER
);
-- WebAuthn 挑战 / 找回票据（一次性，3/10 分钟过期）
CREATE TABLE IF NOT EXISTS sec_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  mode TEXT NOT NULL,
  phone TEXT DEFAULT '',
  expires INTEGER NOT NULL
);
-- 设备码授权（RFC 8628 风格，5 分钟过期）
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE,
  phone TEXT,
  status TEXT NOT NULL,
  expires INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- 签名公钥托管（私钥加密存于用户本机）
CREATE TABLE IF NOT EXISTS sign_keys (
  phone TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  created_at INTEGER
);
-- 安全审计日志（登录/授权/重置等事件）
CREATE TABLE IF NOT EXISTS security_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  phone TEXT,
  event TEXT,
  detail TEXT
);
-- 频控计数（滑动窗口防爆破）
CREATE TABLE IF NOT EXISTS sec_rate (
  k TEXT PRIMARY KEY,
  c INTEGER DEFAULT 0,
  ws INTEGER DEFAULT 0
);
