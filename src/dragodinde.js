const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

const setupDrafts = new Map();

function isAdmin(interaction) {
  return interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function getDraft(guildId) {
  if (!setupDrafts.has(guildId)) {
    setupDrafts.set(guildId, {
      logsChannelId: null,
      dashboardChannelId: null,
      adminRoleId: null,
      allowedRoleIds: [],
    });
  }
  return setupDrafts.get(guildId);
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('dragodinde_setup')
      .setDescription('Configurer le module Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_ping')
      .setDescription('Vérifier que le module Dragodinde répond'),
  ];
}

async function onReady() {
  return true;
}

function buildSetupComponents(guild) {
  const textChannels = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .first(25)
    .map((ch) => new StringSelectMenuOptionBuilder().setLabel(ch.name.slice(0, 100)).setValue(ch.id));

  const roles = guild.roles.cache
    .filter((role) => role.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .first(25)
    .map((role) => new StringSelectMenuOptionBuilder().setLabel(role.name.slice(0, 100)).setValue(role.id));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dragodinde:setup:logs:${guild.id}`)
        .setPlaceholder('Choisir le salon des logs')
        .addOptions(textChannels)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dragodinde:setup:dashboard:${guild.id}`)
        .setPlaceholder('Choisir le salon du dashboard')
        .addOptions(textChannels)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dragodinde:setup:admin:${guild.id}`)
        .setPlaceholder('Choisir le rôle admin')
        .addOptions(roles)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dragodinde:setup:save:${guild.id}`)
        .setLabel('✅ Valider la configuration')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`dragodinde:setup:cancel:${guild.id}`)
        .setLabel('❌ Annuler')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function handleChatInputCommand(interaction) {
  if (interaction.commandName === 'dragodinde_ping') {
    await interaction.reply({ content: '🏇 Module Dragodinde prêt.', ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'dragodinde_setup') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
      return true;
    }

    getDraft(interaction.guild.id);
    await interaction.reply({
      content: 'Bienvenue dans la configuration Dragodinde. Choisis les éléments ci-dessous puis valide.',
      components: buildSetupComponents(interaction.guild),
      ephemeral: true,
    });
    return true;
  }

  return false;
}

async function handleConfigSelect(interaction) {
  if (!interaction.customId.startsWith('dragodinde:setup:')) return false;
  const [, , key, guildId] = interaction.customId.split(':');
  if (!interaction.guild || interaction.guild.id !== guildId) return false;

  const draft = getDraft(guildId);
  const value = interaction.values?.[0] || null;
  if (key === 'logs') draft.logsChannelId = value;
  if (key === 'dashboard') draft.dashboardChannelId = value;
  if (key === 'admin') draft.adminRoleId = value;

  await interaction.reply({ content: '✅ Sélection enregistrée.', ephemeral: true });
  return true;
}

async function handleButtonInteraction(interaction) {
  if (!interaction.customId.startsWith('dragodinde:setup:')) return false;
  const [, , action, guildId] = interaction.customId.split(':');
  if (!interaction.guild || interaction.guild.id !== guildId) return false;

  if (action === 'cancel') {
    setupDrafts.delete(guildId);
    await interaction.update({ content: 'Configuration Dragodinde annulée.', components: [] });
    return true;
  }

  if (action === 'save') {
    const draft = getDraft(guildId);
    await interaction.update({
      content:
        'Configuration Dragodinde enregistrée (squelette).\n' +
        `• Logs: ${draft.logsChannelId ? `<#${draft.logsChannelId}>` : '—'}\n` +
        `• Dashboard: ${draft.dashboardChannelId ? `<#${draft.dashboardChannelId}>` : '—'}\n` +
        `• Admin: ${draft.adminRoleId ? `<@&${draft.adminRoleId}>` : '—'}`,
      components: [],
    });
    return true;
  }

  return false;
}

module.exports = {
  buildCommands,
  onReady,
  handleChatInputCommand,
  handleButtonInteraction,
  handleConfigSelect,
};
