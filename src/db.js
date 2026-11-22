'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ffd.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','contractor')),
  contractor_id INTEGER REFERENCES contractors(id) ON DELETE CASCADE,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  region TEXT DEFAULT '',
  airport TEXT DEFAULT '',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS requirement_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('passport','visa','immunization','id','clearance','other')),
  has_expiry INTEGER NOT NULL DEFAULT 1,
  min_validity_days INTEGER NOT NULL DEFAULT 0,  -- must stay valid this many days past the rotation's return date
  lead_days INTEGER NOT NULL DEFAULT 30,          -- how long it typically takes to renew / obtain
  instructions TEXT DEFAULT '',
  keyword TEXT DEFAULT ''          -- used to match contractor intake entries (e.g. 'yellow fever', 'iraq')
);
CREATE TABLE IF NOT EXISTS destination_requirements (
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  requirement_type_id INTEGER NOT NULL REFERENCES requirement_types(id) ON DELETE CASCADE,
  PRIMARY KEY (destination_id, requirement_type_id)
);
CREATE TABLE IF NOT EXISTS contractors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  employee_no TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  home_airport TEXT DEFAULT '',
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  deploy_date TEXT,           -- start of upcoming / current rotation (YYYY-MM-DD)
  rotation_on INTEGER NOT NULL DEFAULT 60,
  rotation_off INTEGER NOT NULL DEFAULT 30,
  next_deploy_date TEXT,      -- optional explicit start of the rotation after this one
  override_status TEXT CHECK (override_status IN ('red','yellow','green') OR override_status IS NULL),
  override_reason TEXT,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  requirement_type_id INTEGER NOT NULL REFERENCES requirement_types(id) ON DELETE CASCADE,
  ref_last4 TEXT DEFAULT '',  -- only last 4 of doc numbers stored in the prototype
  issued TEXT,
  expires TEXT,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','pending','rejected')),
  notes TEXT DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'admin',
  upload_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contractor_id, requirement_type_id)
);
CREATE TABLE IF NOT EXISTS blockers (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  airline TEXT NOT NULL,
  flight_no TEXT NOT NULL,
  from_airport TEXT NOT NULL,
  to_airport TEXT NOT NULL,
  depart_at TEXT NOT NULL,
  arrive_at TEXT,
  confirmation TEXT DEFAULT '',
  seat TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  seen_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  contractor_id INTEGER PRIMARY KEY REFERENCES contractors(id) ON DELETE CASCADE,
  data_enc TEXT NOT NULL,          -- AES-256-GCM encrypted JSON
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  file TEXT NOT NULL,              -- encrypted blob on disk under data/uploads
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'info' CHECK (kind IN ('info','flight','urgent','readiness')),
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  sent_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
