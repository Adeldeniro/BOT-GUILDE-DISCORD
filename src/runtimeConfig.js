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

    // Dashboard
    dashboardChannelId: pick(gc.dashboard_channel_id, null),
    dashboardMessageId: pick(gc.dashboard_message_id, null),

    // Welcome
    welcomeChannelId: pick(gc.welcome_channel_id, null),
    welcomeGuildName: pick(gc.welcome_guild_name, 'GTO'),
    welcomePingEveryone: Boolean(Number(pick(gc.welcome_ping_everyone, 0) || 0)),
    welcomeRoleGuildeuxId: pick(gc.welcome_role_guildeux_id, null),
    welcomeRoleInviteId: pick(gc.welcome_role_invite_id, null),
  };
}

module.exports = {
  getConfigForGuild,
};
