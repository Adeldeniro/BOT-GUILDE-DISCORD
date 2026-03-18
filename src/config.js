require('dotenv').config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

module.exports = {
  token: must('DISCORD_TOKEN'),

  // Defaults (can be overridden per-guild via DB / setup commands)
  guildId: process.env.GUILD_ID || null,
  defaultChannelId: process.env.DEFAULT_CHANNEL_ID || null,
  defRoleId: process.env.DEF_ROLE_ID || null,
  panelTitle: process.env.PANEL_TITLE || 'Ping DEF',
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 10),
  alertChannelId: process.env.ALERT_CHANNEL_ID || process.env.DEFAULT_CHANNEL_ID || null,

  // Admin roles (legacy env allowlist; per-guild admin role can be configured via /setup_admin)
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Scoreboard (guildeux)
  guildeuxRoleId: process.env.GUILDEUX_ROLE_ID || null,
  scoreboardChannelId: process.env.SCOREBOARD_CHANNEL_ID || null,
  scoreboardTopN: Number(process.env.SCOREBOARD_TOP_N || 25),

  // DeepL (optional)
  deeplApiKey: process.env.DEEPL_API_KEY || null,
};
