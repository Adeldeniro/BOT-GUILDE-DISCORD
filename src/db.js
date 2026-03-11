const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS panels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT,
  alert_channel_id TEXT,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS guild_buttons (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT,
  unicode_prefix TEXT,
  sort_order INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id, name)
);

-- Scoreboard (guildeux)
CREATE TABLE IF NOT EXISTS guildeux_scores (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ping_count INTEGER NOT NULL DEFAULT 0,
  last_ping_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS scoreboard_state (
  guild_id TEXT NOT NULL PRIMARY KEY,
  channel_id TEXT,
  message_id TEXT,
  last_weekly_announce_date TEXT
);

-- Per-guild config (makes installation easy)
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT NOT NULL PRIMARY KEY,
  admin_role_id TEXT,
  panel_channel_id TEXT,
  alert_channel_id TEXT,
  def_role_id TEXT,
  panel_title TEXT,
  cooldown_seconds INTEGER,
  scoreboard_channel_id TEXT,
  guildeux_role_id TEXT,
  scoreboard_top_n INTEGER,
  dashboard_channel_id TEXT,
  dashboard_message_id TEXT,
  welcome_channel_id TEXT,
  welcome_guild_name TEXT,
  welcome_ping_everyone INTEGER,
  welcome_role_guildeux_id TEXT,
  welcome_role_invite_id TEXT,
  rules_channel_id TEXT,
  rules_message_id TEXT,
  rules_access_role_id TEXT,
  validation_channel_id TEXT,
  validation_staff_role_ids TEXT,
  validation_gto_role_id TEXT,
  validation_def_role_id TEXT
);
`);

// Migration for older DBs
const panelCols = db.prepare(`PRAGMA table_info(panels)`).all().map(r => r.name);
if (!panelCols.includes('alert_channel_id')) {
  db.exec('ALTER TABLE panels ADD COLUMN alert_channel_id TEXT');
}
const btnCols = db.prepare(`PRAGMA table_info(guild_buttons)`).all().map(r => r.name);
if (!btnCols.includes('unicode_prefix')) {
  db.exec('ALTER TABLE guild_buttons ADD COLUMN unicode_prefix TEXT');
}

// Migration for guild_config (setup/dashboard)
const cfgCols = db.prepare(`PRAGMA table_info(guild_config)`).all().map(r => r.name);
if (!cfgCols.includes('dashboard_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN dashboard_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('dashboard_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN dashboard_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('welcome_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('welcome_guild_name')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_guild_name TEXT'); } catch {}
}
if (!cfgCols.includes('welcome_ping_everyone')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_ping_everyone INTEGER'); } catch {}
}
if (!cfgCols.includes('welcome_role_guildeux_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_role_guildeux_id TEXT'); } catch {}
}
if (!cfgCols.includes('welcome_role_invite_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_role_invite_id TEXT'); } catch {}
}
if (!cfgCols.includes('rules_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN rules_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('rules_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN rules_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('rules_access_role_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN rules_access_role_id TEXT'); } catch {}
}
if (!cfgCols.includes('validation_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN validation_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('validation_staff_role_ids')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN validation_staff_role_ids TEXT'); } catch {}
}
if (!cfgCols.includes('validation_gto_role_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN validation_gto_role_id TEXT'); } catch {}
}
if (!cfgCols.includes('validation_def_role_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN validation_def_role_id TEXT'); } catch {}
}

module.exports = db;
