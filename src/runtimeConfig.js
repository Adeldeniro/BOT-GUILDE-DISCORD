const env = require('./config');
const { getGuildConfig } = require('./guildConfig');

function pick(v, fallback) {
  return v !== undefined && v !== null && v !== '' ? v : fallback;
}

function getConfigForGuild(guildId) {
  const gc = getGuildConfig(guildId) || {};

  return {
    guildId,

    // Admin
    adminRoleId: pick(gc.admin_role_id, null),
    adminRoleIdsLegacy: env.adminRoleIds,

    // Ping panel
    panelChannelId: pick(gc.panel_channel_id, env.defaultChannelId),
    alertChannelId: pick(gc.alert_channel_id, env.alertChannelId),
    defRoleId: pick(gc.def_role_id, env.defRoleId),
    panelTitle: pick(gc.panel_title, env.panelTitle),
    cooldownSeconds: Number(pick(gc.cooldown_seconds, env.cooldownSeconds) || 10),

    // Scoreboard
    scoreboardChannelId: pick(gc.scoreboard_channel_id, env.scoreboardChannelId),
    guildeuxRoleId: pick(gc.guildeux_role_id, env.guildeuxRoleId),
    scoreboardTopN: Number(pick(gc.scoreboard_top_n, env.scoreboardTopN) || 25),
  };
}

module.exports = {
  getConfigForGuild,
};
