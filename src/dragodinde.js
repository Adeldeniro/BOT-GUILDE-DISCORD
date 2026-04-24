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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', 'data', 'dragodinde');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const IMAGE_URL = 'https://media.discordapp.net/attachments/1481127126248984679/1494762706899701891/980ba366-2d5c-46c4-b4a9-df92e4e90f70.png?ex=69e3c9c0&is=69e27840&hm=c6652dfdc2999cacc80d9f8df4c6ef01de1a36b28c9e8fd2d3d13b112d7014a8&=&format=webp&quality=lossless';
const RESULT_IMAGE_URL = 'https://cdn.discordapp.com/attachments/1481127126248984679/1495225714117447710/0436af6e-f2de-4962-8e0d-0451f6a9e493.png';
const RACE_BANNER_URL = 'https://cdn.discordapp.com/attachments/1481127126248984679/1495230856178962582/Gemini_Generated_Image_lxhg3glxhg3glxhg.png';
const ENTRY_FEE = 55_000;
const REAL_BET = 50_000;
const MAX_PLAYERS = 4;
const HORSES = [
  { name: 'Tonnerre', emoji: '🐎' },
  { name: 'Éclair', emoji: '⚡' },
  { name: 'Foudre', emoji: '🌩️' },
  { name: 'Tempête', emoji: '🌊' },
];

const setupDrafts = new Map();
const userSessions = new Map();
const raceStates = new Map();

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
    notificationRoleId: null,
    allowedRoleIds: [],
    dashboardMessageId: null,
    mainChannelId: null,
    mainMessageId: null,
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

function getMainMessageContent() {
  return [
    '**🏇 PMU de la Guilde, mise sur ta Dragodinde ! 🏇🎰**',
    '',
    'Bienvenue au **PMU de la Guilde**.',
    'Ici, on ne vient pas caresser la piste. On vient poser sa mise, serrer les dents, et espérer que sa Dragodinde ait plus de cœur que son propriétaire.',
    '',
    '**💸 Mises et règles**',
    `• Course entre joueurs : entrée à **${ENTRY_FEE.toLocaleString('fr-FR')} kamas**`,
    `• Somme réellement mise en jeu : **${REAL_BET.toLocaleString('fr-FR')} kamas** par joueur`,
    '• Si la grille n’est pas complète, l’IA prend les places libres au départ',
    '',
    '**🎮 Comment jouer ?**',
    '• Clique sur **Participer**',
    '• Choisis ton mode',
    '• Choisis ta Dragodinde',
    '• Puis regarde si tu repars avec des kamas... ou juste avec la honte',
    '',
    `*Capacité max : ${MAX_PLAYERS} joueurs humains*`,
  ].join('\n');
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('dragodinde_setup')
      .setDescription('Configurer le jeu et créer l’annonce épinglée'),
    new SlashCommandBuilder()
      .setName('dragodinde_panel')
      .setDescription('Créer ou mettre à jour le panneau Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_status')
      .setDescription('Afficher l’état actuel de la configuration Dragodinde'),
  ];
}

function joinButtonRow() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dragodinde:join:main').setLabel('Participer').setEmoji('🐎').setStyle(ButtonStyle.Success)
  )];
}

function modeChoiceRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:mode:ia:${userId}`).setLabel("Contre l'IA").setEmoji('🤖').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dragodinde:mode:players:${userId}`).setLabel("Contre d'autres joueurs").setEmoji('🏁').setStyle(ButtonStyle.Success)
  )];
}

function horseChoiceRows(userId, mode) {
  return [new ActionRowBuilder().addComponents(
    ...HORSES.map((horse, i) => new ButtonBuilder()
      .setCustomId(`dragodinde:horse:${mode}:${i}:${userId}`)
      .setLabel(horse.name)
      .setEmoji(horse.emoji)
      .setStyle(ButtonStyle.Primary))
  )];
}

function buildPanelEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🏇 Course Dragodinde')
    .setDescription(getMainMessageContent())
    .addFields(
      { name: 'Salon des logs', value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '—', inline: true },
      { name: 'Salon du dashboard', value: cfg.dashboardChannelId ? `<#${cfg.dashboardChannelId}>` : '—', inline: true },
      { name: 'Rôle admin', value: cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '—', inline: true },
    )
    .setImage(IMAGE_URL)
    .setFooter({ text: 'Dragodinde phase 1 jouable.' });
}

function buildRaceStatusEmbed(phase, { creatorId = null, humans = [], pot = 0, winnerId = null, winnerName = null } = {}) {
  const colorMap = {
    waiting: 0xF1C40F,
    launching: 0x3498DB,
    running: 0x9B59B6,
    finished: 0x2ECC71,
    cancelled: 0xE74C3C,
  };

  const embed = new EmbedBuilder()
    .setTitle('🏇 Course Dragodinde')
    .setColor(colorMap[phase] ?? 0x3498DB);

  if (phase === 'waiting') {
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription(`**<@${creatorId}>** cherche des adversaires.\nInscrits : **${humans.length}/${MAX_PLAYERS}**\nPlaces restantes : **${Math.max(0, MAX_PLAYERS - humans.length)}**`)
      .addFields(
        { name: 'Joueurs engagés', value: humans.length ? humans.map((p) => `${HORSES[p.horseIndex].emoji} <@${p.userId}> avec **${HORSES[p.horseIndex].name}**`).join('\n') : 'Aucun', inline: false },
        { name: 'Cagnotte actuelle', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: false },
      );
  } else if (phase === 'launching') {
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription('La grille s’ouvre, les sabots frappent le sol, la course se prépare...');
  } else if (phase === 'running') {
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription('La course est lancée ! Les dragodindes sont sur la piste.');
  } else if (phase === 'finished') {
    embed
      .setImage(RESULT_IMAGE_URL)
      .setDescription('La poussière retombe. La piste a rendu son verdict.')
      .addFields(
        { name: 'Vainqueur', value: winnerId ? `<@${winnerId}> (${winnerName})` : `IA (${winnerName})`, inline: false },
        { name: 'Montant', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: false },
      );
  }

  return embed;
}

async function ensureDashboardPanel(channel, guildId) {
  const cfg = getGuildConfig(guildId);
  const embed = buildPanelEmbed(guildId);
  const components = joinButtonRow();
  if (cfg.dashboardMessageId) {
    const existing = await channel.messages.fetch(cfg.dashboardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      return existing;
    }
  }
  const msg = await channel.send({ embeds: [embed], components });
  setGuildConfig(guildId, { ...cfg, dashboardMessageId: msg.id, mainChannelId: channel.id, mainMessageId: msg.id });
  return msg;
}

async function onReady() {
  ensureDataDir();
  return true;
}

function getSelectableTextChannels(guild) {
  return [...guild.channels.cache.values()]
    .filter((ch) => ch.type === ChannelType.GuildText)
    .sort((a, b) => {
      if (a.rawPosition !== b.rawPosition) return a.rawPosition - b.rawPosition;
      return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
    });
}

function channelSelectRow(guild, customId, placeholder) {
  const textChannels = getSelectableTextChannels(guild).slice(0, 25);
  const options = textChannels.length
    ? textChannels.map((ch) => new StringSelectMenuOptionBuilder().setLabel(ch.name.slice(0, 100)).setValue(ch.id))
    : [new StringSelectMenuOptionBuilder().setLabel('Aucun salon texte disponible').setValue('__none__')];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(!textChannels.length)
    .addOptions(options);
  return new ActionRowBuilder().addComponents(menu);
}

function buildSetupComponents(guild) {
  const roleList = guild.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .first(25);

  const roleOptions = roleList.length
    ? roleList.map((role) => new StringSelectMenuOptionBuilder().setLabel(role.name.slice(0, 100)).setValue(role.id))
    : [new StringSelectMenuOptionBuilder().setLabel('Aucun rôle disponible').setValue('__none__')];

  return [
    channelSelectRow(guild, `dragodinde:setup:logs:${guild.id}`, 'Salon des logs (liste rapide)'),
    channelSelectRow(guild, `dragodinde:setup:dashboard:${guild.id}`, 'Salon du dashboard (liste rapide)'),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dragodinde:setupsearch:logs:${guild.id}`)
        .setLabel('Rechercher salon logs')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`dragodinde:setupsearch:dashboard:${guild.id}`)
        .setLabel('Rechercher salon dashboard')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dragodinde:setup:admin:${guild.id}`)
        .setPlaceholder('Rôle admin (valider les paiements)')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!roleList.length)
        .addOptions(roleOptions)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`dragodinde:setup:allowed:${guild.id}`)
        .setPlaceholder('Rôle autorisé à jouer (sert aussi pour les notifications)')
        .setMinValues(1)
        .setMaxValues(Math.min(roleList.length || 1, 5))
        .setDisabled(!roleList.length)
        .addOptions(roleOptions)
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

async function showChannelSearchModal(interaction, type, guildId) {
  const modal = new ModalBuilder()
    .setCustomId(`dragodinde:modalsearch:${type}:${guildId}`)
    .setTitle(type === 'logs' ? 'Rechercher le salon logs' : 'Rechercher le salon dashboard');

  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Nom du salon à rechercher')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(type === 'logs' ? 'Ex: logs, pmu, courses...' : 'Ex: dashboard, dragodinde...');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  if (!interaction.customId.startsWith('dragodinde:modalsearch:')) return false;
  const [, , type, guildId] = interaction.customId.split(':');
  if (!interaction.guild || interaction.guild.id !== guildId) return false;

  const query = (interaction.fields.getTextInputValue('query') || '').trim().toLowerCase();
  const channels = getSelectableTextChannels(interaction.guild)
    .filter((ch) => ch.name.toLowerCase().includes(query))
    .slice(0, 10);

  if (!channels.length) {
    await interaction.reply({ content: 'Aucun salon texte trouvé pour cette recherche.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.reply({
    content: `Résultats pour **${query}** :`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`dragodinde:setup:${type}:${guildId}`)
          .setPlaceholder('Choisis un salon trouvé')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(channels.map((ch) => new StringSelectMenuOptionBuilder().setLabel(ch.name.slice(0, 100)).setValue(ch.id)))
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function runSimpleRace(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state) return;

  await channel.send({ embeds: [buildRaceStatusEmbed('launching', { creatorId: state.creatorId, humans: state.players, pot: REAL_BET * state.players.length })] }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  await channel.send({ embeds: [buildRaceStatusEmbed('running', { creatorId: state.creatorId, humans: state.players, pot: REAL_BET * state.players.length })] }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));

  const contestants = [...state.players];
  while (contestants.length < MAX_PLAYERS) {
    const used = new Set(contestants.map((p) => p.horseIndex));
    const available = HORSES.map((_, i) => i).filter((i) => !used.has(i));
    const horseIndex = available[Math.floor(Math.random() * available.length)] ?? 0;
    contestants.push({ userId: null, horseIndex, ai: true });
  }

  const winner = contestants[Math.floor(Math.random() * contestants.length)];
  await channel.send({
    embeds: [buildRaceStatusEmbed('finished', {
      humans: state.players,
      pot: REAL_BET * state.players.length,
      winnerId: winner.userId,
      winnerName: HORSES[winner.horseIndex].name,
    })],
  }).catch(() => {});

  raceStates.delete(guildId);
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
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.commandName === 'dragodinde_panel') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const cfg = getGuildConfig(interaction.guild.id);
    if (!cfg.dashboardChannelId) {
      await interaction.reply({ content: 'Configure d’abord le salon dashboard avec /dragodinde_setup.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const channel = await interaction.client.channels.fetch(cfg.dashboardChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'Salon dashboard inaccessible.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const msg = await ensureDashboardPanel(channel, interaction.guild.id);
    await interaction.reply({ content: `✅ Panneau Dragodinde prêt dans ${channel} (message ${msg.id}).`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.commandName === 'dragodinde_setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour utiliser cette commande.' });
      return true;
    }

    getDraft(interaction.guild.id);
    await interaction.editReply({
      content: '### 🐎 Bienvenue dans la configuration du jeu\nChoisis tous les éléments, puis valide à la fin. Rien ne sera créé avant validation.',
      components: buildSetupComponents(interaction.guild),
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
  if (key === 'logs' && value !== '__none__') draft.logsChannelId = value;
  if (key === 'dashboard' && value !== '__none__') draft.dashboardChannelId = value;
  if (key === 'admin' && value !== '__none__') draft.adminRoleId = value;
  if (key === 'allowed') {
    draft.allowedRoleIds = [...(interaction.values || [])].filter((v) => v !== '__none__');
    draft.notificationRoleId = draft.allowedRoleIds[0] || null;
  }

  await interaction.reply({ content: '✅ Sélection enregistrée.', flags: MessageFlags.Ephemeral });
  return true;
}

async function handleButtonInteraction(interaction) {
  if (interaction.customId.startsWith('dragodinde:setupsearch:')) {
    const [, type, guildId] = interaction.customId.split(':');
    if (!interaction.guild || interaction.guild.id !== guildId) return false;
    await showChannelSearchModal(interaction, type, guildId);
    return true;
  }

  if (interaction.customId === 'dragodinde:join:main') {
    userSessions.set(interaction.user.id, { guildId: interaction.guild.id });
    await interaction.reply({
      content: 'Choisis ton mode de jeu.',
      components: modeChoiceRows(interaction.user.id),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:mode:')) {
    const [, , mode, userId] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const session = userSessions.get(userId) || {};
    session.mode = mode;
    userSessions.set(userId, session);
    await interaction.update({
      content: `Mode sélectionné : **${mode === 'ia' ? "Contre l'IA" : "Contre d'autres joueurs"}**\nChoisis maintenant ta Dragodinde.`,
      components: horseChoiceRows(userId, mode),
    });
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:horse:')) {
    const [, , , mode, horseIndexRaw, userId] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const horseIndex = Number(horseIndexRaw);
    const guildId = interaction.guild.id;
    const horse = HORSES[horseIndex];

    if (mode === 'ia') {
      await interaction.update({
        content: `✅ Tu as choisi **${horse.emoji} ${horse.name}** pour affronter l’IA. La course démarre...`,
        components: [],
      });
      raceStates.set(guildId, {
        creatorId: interaction.user.id,
        players: [{ userId: interaction.user.id, horseIndex, ai: false }],
      });
      await runSimpleRace(interaction.channel, guildId);
      return true;
    }

    const state = raceStates.get(guildId) || { creatorId: interaction.user.id, players: [] };
    if (!state.players.find((p) => p.userId === interaction.user.id)) {
      state.players.push({ userId: interaction.user.id, horseIndex, ai: false });
    }
    raceStates.set(guildId, state);

    await interaction.update({
      content: `✅ Tu es inscrit avec **${horse.emoji} ${horse.name}**.\nLa recherche de joueurs commence...`,
      components: [],
    });

    await interaction.channel.send({
      embeds: [buildRaceStatusEmbed('waiting', {
        creatorId: state.creatorId,
        humans: state.players,
        pot: REAL_BET * state.players.length,
      })],
    }).catch(() => {});

    if (state.players.length >= 2) {
      await runSimpleRace(interaction.channel, guildId);
    }
    return true;
  }

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
        `• Admin: ${draft.adminRoleId ? `<@&${draft.adminRoleId}>` : '—'}\n` +
        `• Rôle autorisé: ${draft.allowedRoleIds?.length ? draft.allowedRoleIds.map((rid) => `<@&${rid}>`).join(', ') : '—'}\n\n` +
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
  handleModalSubmit,
};
