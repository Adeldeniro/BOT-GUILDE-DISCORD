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
  welcome_chat_channel_id TEXT,
  almanax_channel_id TEXT,
  almanax_last_post_ymd TEXT,
  rules_channel_id TEXT,
  rules_message_id TEXT,
  rules_access_role_id TEXT,
  validation_channel_id TEXT,
  validation_staff_role_ids TEXT,
  validation_gto_role_id TEXT,
  validation_def_role_id TEXT,
  profiles_channel_id TEXT,
  help_channel_id TEXT,
  help_message_id TEXT,
  surveillance_channel_id TEXT,
  activitylog_channel_id TEXT,
  event_proofs_channel_id TEXT,
  event_validation_channel_id TEXT,
  event_scoreboard_channel_id TEXT,
  event_screens_channel_id TEXT,
  event_admin_channel_id TEXT,
  event_admin_message_id TEXT,
  event_submit_panel_channel_id TEXT,
  event_submit_panel_message_id TEXT,
  ankama_profile_channel_id TEXT,
  ankama_profile_message_id TEXT,
  dofusbook_panel_channel_id TEXT,
  dofusbook_panel_message_id TEXT
);

CREATE TABLE IF NOT EXISTS dofusbook_builds (
  guild_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  class_key TEXT NOT NULL,
  element_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  build_name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  participants TEXT NOT NULL,
  participants_override TEXT,
  proofs_channel_id TEXT NOT NULL,
  proofs_message_id TEXT NOT NULL,
  pending_reply_message_id TEXT,
  staff_message_id TEXT,
  staff_control_message_id TEXT,
  screen_message_id TEXT,
  defenders_present INTEGER,
  points INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  validated_by TEXT,
  validated_at INTEGER,
  deny_reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_scores (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (guild_id, user_id)
);

-- Per-submission applied award (so we can rollback/recompute)
CREATE TABLE IF NOT EXISTS event_awards (
  guild_id TEXT NOT NULL,
  submission_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, submission_id, user_id)
);

CREATE TABLE IF NOT EXISTS event_scoreboard_state (
  guild_id TEXT NOT NULL PRIMARY KEY,
  channel_id TEXT,
  message_id TEXT
);

CREATE TABLE IF NOT EXISTS event_drafts (
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  participants TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, author_id)
);


CREATE TABLE IF NOT EXISTS player_profiles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  ign TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  profile_message_id TEXT,
  PRIMARY KEY (guild_id, user_id)
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
if (!cfgCols.includes('welcome_chat_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN welcome_chat_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('almanax_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN almanax_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('almanax_last_post_ymd')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN almanax_last_post_ymd TEXT'); } catch {}
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
if (!cfgCols.includes('profiles_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN profiles_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('help_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN help_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('help_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN help_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('surveillance_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN surveillance_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('activitylog_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN activitylog_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_proofs_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_proofs_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_validation_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_validation_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_scoreboard_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_scoreboard_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_screens_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_screens_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_admin_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_admin_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_admin_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_admin_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_submit_panel_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_submit_panel_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('event_submit_panel_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN event_submit_panel_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('ankama_profile_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN ankama_profile_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('ankama_profile_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN ankama_profile_message_id TEXT'); } catch {}
}
if (!cfgCols.includes('dofusbook_panel_channel_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN dofusbook_panel_channel_id TEXT'); } catch {}
}
if (!cfgCols.includes('dofusbook_panel_message_id')) {
  try { db.exec('ALTER TABLE guild_config ADD COLUMN dofusbook_panel_message_id TEXT'); } catch {}
}

// Migration for event_submissions
const evCols = db.prepare(`PRAGMA table_info(event_submissions)`).all().map(r => r.name);
if (!evCols.includes('participants_override')) {
  try { db.exec('ALTER TABLE event_submissions ADD COLUMN participants_override TEXT'); } catch {}
}
if (!evCols.includes('pending_reply_message_id')) {
  try { db.exec('ALTER TABLE event_submissions ADD COLUMN pending_reply_message_id TEXT'); } catch {}
}
if (!evCols.includes('deny_reason')) {
  try { db.exec('ALTER TABLE event_submissions ADD COLUMN deny_reason TEXT'); } catch {}
}
if (!evCols.includes('staff_control_message_id')) {
  try { db.exec('ALTER TABLE event_submissions ADD COLUMN staff_control_message_id TEXT'); } catch {}
}
if (!evCols.includes('screen_message_id')) {
  try { db.exec('ALTER TABLE event_submissions ADD COLUMN screen_message_id TEXT'); } catch {}
}

// Migration for event_awards
try {
  db.prepare('SELECT 1 FROM event_awards LIMIT 1').get();
} catch {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS event_awards (
      guild_id TEXT NOT NULL,
      submission_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      points INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, submission_id, user_id)
    );`);
  } catch {}
}

// Migration for event_drafts
try {
  const draftCols = db.prepare(`PRAGMA table_info(event_drafts)`).all().map(r => r.name);
  if (!draftCols.includes('stage')) {
    db.exec("ALTER TABLE event_drafts ADD COLUMN stage TEXT NOT NULL DEFAULT 'need_participants'");
  }
} catch {}

// Migration for player_profiles
const profCols = db.prepare(`PRAGMA table_info(player_profiles)`).all().map(r => r.name);
if (!profCols.includes('profile_message_id')) {
  try { db.exec('ALTER TABLE player_profiles ADD COLUMN profile_message_id TEXT'); } catch {}
}

module.exports = db;
