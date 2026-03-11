require('dotenv').config();

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

module.exports = {
  token: must('DISCORD_TOKEN'),
  guildId: must('GUILD_ID'),
  defaultChannelId: must('DEFAULT_CHANNEL_ID'),
  defRoleId: must('DEF_ROLE_ID'),
  panelTitle: process.env.PANEL_TITLE || 'Ping DEF',
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 10),
  alertChannelId: process.env.ALERT_CHANNEL_ID || must('DEFAULT_CHANNEL_ID'),
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Scoreboard (guildeux)
  guildeuxRoleId: must('GUILDEUX_ROLE_ID'),
  scoreboardChannelId: must('SCOREBOARD_CHANNEL_ID'),
  scoreboardTopN: Number(process.env.SCOREBOARD_TOP_N || 25),
};
