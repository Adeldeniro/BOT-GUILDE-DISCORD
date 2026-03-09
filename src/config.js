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
  cooldownSeconds: Number(process.env.COOLDOWN_SECONDS || 30),
};
