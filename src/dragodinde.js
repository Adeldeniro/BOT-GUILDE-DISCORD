const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
} = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', 'data', 'dragodinde');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const setupDrafts = new Map();

function isAdmin(interaction) {
  return interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function getGuildConfig(guildId) {
  const config = loadConfig();
  return config[guildId] || {
    logsChannelId: null,
    dashboardChannelId: null,
    adminRoleId: null,
    allowedRoleIds: [],
    dashboardMessageId: null,
  };
}

function setGuildConfig(guildId, value) {
  const config = loadConfig();
  config[guildId] = value;
  saveConfig(config);
}

function getDraft(guildId) {
  if (!setupDrafts.has(guildId)) {
    setupDrafts.set(guildId, { ...getGuildConfig(guildId) });
  }
  return setupDrafts.get(guildId);
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('dragodinde_setup')
      .setDescription('Configurer le module Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_panel')
      .setDescription('Créer ou mettre à jour le panneau Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_status')
      .setDescription('Afficher l’état actuel de la configuration Dragodinde'),
  ];
}

function buildPanelEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  return new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle('🏇 Dragodinde')
    .setDescription('Module Dragodinde prêt pour la réintégration progressive.')
    .addFields(
      { name: 'Salon logs', value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '—', inline: true },
      { name: 'Salon dashboard', value: cfg.dashboardChannelId ? `<#${cfg.dashboardChannelId}>` : '—', inline: true },
      { name: 'Rôle admin', value: cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '—', inline: true },
    )
    .setFooter({ text: 'Étape suivante: inscription joueurs, course, finance.' });
}

async function ensureDashboardPanel(channel, guildId) {
  const cfg = getGuildConfig(guildId);
  const embed = buildPanelEmbed(guildId);
  if (cfg.dashboardMessageId) {
    const existing = await channel.messages.fetch(cfg.dashboardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components: [] });
      return existing;
    }
  }
  const msg = await channel.send({ embeds: [embed], components: [] });
  setGuildConfig(guildId, { ...cfg, dashboardMessageId: msg.id });
  return msg;
}

async function onReady() {
  ensureDataDir();
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
  if (interaction.commandName === 'dragodinde_status') {
    const cfg = getGuildConfig(interaction.guild.id);
    await interaction.reply({
      content:
        'État Dragodinde actuel.\n' +
        `• Logs: ${cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '—'}\n` +
        `• Dashboard: ${cfg.dashboardChannelId ? `<#${cfg.dashboardChannelId}>` : '—'}\n` +
        `• Admin: ${cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '—'}\n` +
        `• Panneau: ${cfg.dashboardMessageId || '—'}`,
      ephemeral: true,
    });
    return true;
  }

  if (interaction.commandName === 'dragodinde_panel') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
      return true;
    }
    const cfg = getGuildConfig(interaction.guild.id);
    if (!cfg.dashboardChannelId) {
      await interaction.reply({ content: 'Configure d’abord le salon dashboard avec /dragodinde_setup.', ephemeral: true });
      return true;
    }
    const channel = await interaction.client.channels.fetch(cfg.dashboardChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'Salon dashboard inaccessible.', ephemeral: true });
      return true;
    }
    const msg = await ensureDashboardPanel(channel, interaction.guild.id);
    await interaction.reply({ content: `✅ Panneau Dragodinde prêt dans ${channel} (message ${msg.id}).`, ephemeral: true });
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
    setGuildConfig(guildId, { ...getGuildConfig(guildId), ...draft });
    await interaction.update({
      content:
        'Configuration Dragodinde enregistrée.\n' +
        `• Logs: ${draft.logsChannelId ? `<#${draft.logsChannelId}>` : '—'}\n` +
        `• Dashboard: ${draft.dashboardChannelId ? `<#${draft.dashboardChannelId}>` : '—'}\n` +
        `• Admin: ${draft.adminRoleId ? `<@&${draft.adminRoleId}>` : '—'}\n\n` +
        'Tu peux maintenant utiliser /dragodinde_panel pour générer le panneau.',
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
