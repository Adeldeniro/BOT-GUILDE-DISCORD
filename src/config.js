require('dotenv').config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function csv(name) {
  return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
}

const legacyGuildId = process.env.GUILD_ID || null;
const guildIds = [...new Set([...csv('GUILD_IDS'), ...(legacyGuildId ? [legacyGuildId] : [])])];

module.exports = {
  token: must('DISCORD_TOKEN'),

  // Defaults (can be overridden per-guild via DB / setup commands)
  // GUILD_ID remains the primary/legacy guild. GUILD_IDS adds installations
  // without letting legacy channel/role IDs bleed into those guilds.
  guildId: legacyGuildId,
  guildIds,
  defaultChannelId: process.env.DEFAULT_CHANNEL_ID || null,
  defRoleId: process.env.DEF_ROLE_ID || null,
  panelTitle: process.env.PANEL_TITLE || 'Ping DEF',
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 10),
  alertChannelId: process.env.ALERT_CHANNEL_ID || process.env.DEFAULT_CHANNEL_ID || null,

  // Admin roles (legacy env allowlist; per-guild admin role can be configured via /setup_admin)
  adminRoleIds: csv('ADMIN_ROLE_IDS'),

  // Scoreboard (guildeux)
  guildeuxRoleId: process.env.GUILDEUX_ROLE_ID || null,
  scoreboardChannelId: process.env.SCOREBOARD_CHANNEL_ID || null,
  scoreboardTopN: Number(process.env.SCOREBOARD_TOP_N || 25),

  // DeepL (optional)
  deeplApiKey: process.env.DEEPL_API_KEY || null,

  // Logging / monitoring
  logLevel: process.env.LOG_LEVEL || 'info',
  logToFile: String(process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false',
  logDir: process.env.LOG_DIR || 'logs',
  heartbeatIntervalSeconds: Number(process.env.HEARTBEAT_INTERVAL_SECONDS || 300),
};
