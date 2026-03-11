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

    // Rules gating
    rulesChannelId: pick(gc.rules_channel_id, null),
    rulesMessageId: pick(gc.rules_message_id, null),
    rulesAccessRoleId: pick(gc.rules_access_role_id, null),

    // Staff validation
    validationChannelId: pick(gc.validation_channel_id, null),
    validationStaffRoleIds: String(pick(gc.validation_staff_role_ids, '') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    validationGtoRoleId: pick(gc.validation_gto_role_id, null),
    validationDefRoleId: pick(gc.validation_def_role_id, null),

    profilesChannelId: pick(gc.profiles_channel_id, null),

    helpChannelId: pick(gc.help_channel_id, null),
    helpMessageId: pick(gc.help_message_id, null),

    surveillanceChannelId: pick(gc.surveillance_channel_id, null),
  };
}

module.exports = {
  getConfigForGuild,
};
