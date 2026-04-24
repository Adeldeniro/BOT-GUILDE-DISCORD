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
const DEBTS_FILE = path.join(DATA_DIR, 'debts.json');
const PAYOUTS_FILE = path.join(DATA_DIR, 'payouts.json');
const FINANCE_FILE = path.join(DATA_DIR, 'finance.json');
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
const WAIT_TIME_MS = 45_000;
const CANCEL_WINDOW_MS = 15_000;
const DEBT_LIMIT = 1_000_000;
let debtRecords = null;
let payoutRecords = null;
let finance = null;

function isAdmin(interaction) {
  return interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJsonFile(file, fallback) {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function loadConfig() {
  return readJsonFile(CONFIG_FILE, {});
}

function saveConfig(config) {
  writeJsonFile(CONFIG_FILE, config);
}

function loadDebtRecords() {
  if (!debtRecords) debtRecords = readJsonFile(DEBTS_FILE, {});
  return debtRecords;
}

function saveDebtRecords() {
  writeJsonFile(DEBTS_FILE, loadDebtRecords());
}

function loadPayoutRecords() {
  if (!payoutRecords) payoutRecords = readJsonFile(PAYOUTS_FILE, {});
  return payoutRecords;
}

function savePayoutRecords() {
  writeJsonFile(PAYOUTS_FILE, loadPayoutRecords());
}

function loadFinance() {
  if (!finance) finance = readJsonFile(FINANCE_FILE, {});
  return finance;
}

function saveFinance() {
  writeJsonFile(FINANCE_FILE, loadFinance());
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

function getLogsChannelId(guildId) {
  return getGuildConfig(guildId).logsChannelId || null;
}

function getAdminRoleId(guildId) {
  return getGuildConfig(guildId).adminRoleId || null;
}

function getUserFinance(userId) {
  const db = loadFinance();
  if (!db[userId]) {
    db[userId] = { totalDebt: 0, betsCount: 0, paymentsCount: 0 };
    saveFinance();
  }
  return db[userId];
}

function getUserDebt(userId) {
  return Number(getUserFinance(String(userId)).totalDebt || 0);
}

function addUserDebt(userId, amount) {
  const db = loadFinance();
  const current = getUserFinance(String(userId));
  current.totalDebt = Number(current.totalDebt || 0) + Number(amount || 0);
  current.betsCount = Number(current.betsCount || 0) + 1;
  db[String(userId)] = current;
  saveFinance();
}

function applyUserPayment(userId, amount) {
  const db = loadFinance();
  const current = getUserFinance(String(userId));
  current.totalDebt = Math.max(0, Number(current.totalDebt || 0) - Number(amount || 0));
  current.paymentsCount = Number(current.paymentsCount || 0) + 1;
  db[String(userId)] = current;
  saveFinance();
}

function canUserPlay(member) {
  if (!member) return [false, 'Membre introuvable.'];
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return [true, null];
  const cfg = getGuildConfig(member.guild.id);
  if (cfg.allowedRoleIds?.length) {
    const allowed = cfg.allowedRoleIds.some((rid) => member.roles?.cache?.has(rid));
    if (!allowed) return [false, 'Tu n’as pas le rôle autorisé pour jouer à cette course.'];
  }
  const debt = getUserDebt(member.id);
  if (debt > DEBT_LIMIT) return [false, `Tu es bloqué, ta dette dépasse ${DEBT_LIMIT.toLocaleString('fr-FR')} kamas.`];
  return [true, null];
}

async function createDebtRecord(client, guildId, userId, horseIndex, amount = ENTRY_FEE, meta = {}) {
  const logsChannelId = getLogsChannelId(guildId);
  if (!logsChannelId) return null;
  const channel = await client.channels.fetch(logsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const recordId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const safeAmount = Number(amount || ENTRY_FEE);
  const futureTotal = getUserDebt(userId) + safeAmount;
  const formulaText = meta.formulaLabel ? `**Formule :** ${meta.formulaLabel}\n` : '';

  const embed = new EmbedBuilder()
    .setTitle('💰 Engagement de participation')
    .setDescription(
      `**Joueur :** <@${userId}>\n` +
      `**Montant :** ${safeAmount.toLocaleString('fr-FR')} kamas\n` +
      formulaText +
      `**Cheval :** ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}\n` +
      `**Dette totale après inscription :** ${futureTotal.toLocaleString('fr-FR')} kamas\n` +
      `**Statut :** En attente de paiement`
    )
    .setColor(0xFFA500)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:debtpay:${recordId}`).setLabel('Valider le paiement').setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (!msg) return null;

  const db = loadDebtRecords();
  db[recordId] = {
    recordId,
    guildId,
    userId: String(userId),
    amount: safeAmount,
    horseIndex,
    formulaLabel: meta.formulaLabel || null,
    mode: meta.mode || null,
    status: 'unpaid',
    channelId: channel.id,
    messageId: msg.id,
    createdAt: new Date().toISOString(),
    paidAt: null,
    paidByAdminId: null,
    cancelledAt: null,
    cancelledByUserId: null,
  };
  saveDebtRecords();
  addUserDebt(userId, safeAmount);
  return recordId;
}

async function markDebtCancelled(client, recordId, cancelledByUserId = null) {
  const db = loadDebtRecords();
  const record = db[recordId];
  if (!record || record.status !== 'unpaid') return;
  record.status = 'cancelled';
  record.cancelledAt = new Date().toISOString();
  record.cancelledByUserId = cancelledByUserId ? String(cancelledByUserId) : null;
  saveDebtRecords();

  const channel = await client.channels.fetch(record.channelId).catch(() => null);
  const msg = channel && channel.isTextBased() ? await channel.messages.fetch(record.messageId).catch(() => null) : null;
  if (msg?.embeds?.[0]) {
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0x95A5A6)
      .setDescription((msg.embeds[0].description || '').replace('En attente de paiement', 'Engagement annulé'))
      .setFooter({ text: 'Participation annulée' });
    await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  }
}

function getMainMessageContent() {
  return [
    '**Type de jeu : Course de Dragodinde**',
    '',
    'Bienvenue dans le bouge où les grandes bouches viennent jeter leurs kamas en espérant repartir avec un sourire de travers et les poches pleines.',
    'Ici, les fiers à bras fanfaronnent avant le départ, puis finissent souvent à regarder leur bestiole se traîner comme un sac de farine sur une piste grasse.',
    '',
    'Si ta monture a du souffle, tu peux faire sauter la banque.',
    'Si elle court comme une enclume malade, tu repartiras avec la honte au cul pendant que les autres se foutent de toi.',
    '',
    '**💸 Règles du jeu**',
    `• Course entre joueurs : entrée à **${ENTRY_FEE.toLocaleString('fr-FR')} kamas**`,
    `• Montant réellement mis en jeu : **${REAL_BET.toLocaleString('fr-FR')} kamas** par participant`,
    '• Si tous les emplacements ne sont pas pris, l’IA bouche les trous au départ',
    '',
    '**🤖 Défis contre l’IA**',
    '• **Double ta mise** : entrée 55 000 kamas, gain final **100 000 kamas**',
    '• **Triple ta mise** : entrée 105 000 kamas, gain final **300 000 kamas**',
    '• **Jackpot 2M** : entrée 220 000 kamas, gain final **2 000 000 kamas**',
    '',
    '**🎮 Comment tenter ton coup ?**',
    '• Clique sur **Participer**',
    '• Choisis si tu veux te faire salir par l’IA ou par d’autres clowns du paddock',
    '• Sélectionne ta Dragodinde',
    '• Et croise les doigts pour ne pas finir à sec, avec ton ego piétiné sous les sabots',
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
    new SlashCommandBuilder()
      .setName('dragodinde_reset')
      .setDescription('Supprimer les messages Dragodinde créés par le setup et réinitialiser la config'),
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

function playerCountRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:count:1:${userId}`).setLabel('1 adversaire').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dragodinde:count:2:${userId}`).setLabel('2 adversaires').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dragodinde:count:3:${userId}`).setLabel('3 adversaires').setStyle(ButtonStyle.Primary)
  )];
}

function horseChoiceRows(userId, mode, waiting = false, guildId = null) {
  const taken = new Set();
  if (waiting && guildId && raceStates.has(guildId)) {
    for (const player of raceStates.get(guildId).players || []) {
      taken.add(player.horseIndex);
    }
  }

  return [new ActionRowBuilder().addComponents(
    ...HORSES.map((horse, i) => new ButtonBuilder()
      .setCustomId(`dragodinde:horse:${mode}:${i}:${userId}`)
      .setLabel(horse.name)
      .setEmoji(horse.emoji)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(waiting && taken.has(i)))
  )];
}

function cancelParticipationRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:cancel:${userId}`).setLabel('Annuler ma participation').setStyle(ButtonStyle.Danger)
  )];
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle('🎰 PMU de la Guilde')
    .setDescription(getMainMessageContent())
    .setImage(IMAGE_URL)
    .setFooter({ text: 'Entre, mise, fanfaronne un peu, et assume si ça tourne mal.' });
}

function buildRaceStatusEmbed(phase, { creatorId = null, humans = [], pot = 0, winnerId = null, winnerName = null, expectedHumans = MAX_PLAYERS, remainingSeconds = null } = {}) {
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
      .setDescription(`**<@${creatorId}>** cherche des adversaires.\nInscrits : **${humans.length}/${expectedHumans}**\nPlaces restantes : **${Math.max(0, expectedHumans - humans.length)}**`)
      .addFields(
        { name: 'Joueurs engagés', value: humans.length ? humans.map((p) => `${HORSES[p.horseIndex].emoji} <@${p.userId}> avec **${HORSES[p.horseIndex].name}**`).join('\n') : 'Aucun', inline: false },
        { name: 'Cagnotte actuelle', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: false },
        { name: 'Départ estimé', value: remainingSeconds !== null ? `${remainingSeconds} sec` : 'En attente', inline: true },
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

async function deleteRecentSystemMessages(channel) {
  const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
  if (!messages) return;
  for (const msg of messages.values()) {
    if (msg.system || msg.type === 6) {
      await msg.delete().catch(() => {});
    }
  }
}

async function ensurePinnedRaceMessage(channel, guildId) {
  const cfg = getGuildConfig(guildId);
  const embed = buildPanelEmbed();
  const components = joinButtonRow();

  if (cfg.mainChannelId === channel.id && cfg.mainMessageId) {
    const existing = await channel.messages.fetch(cfg.mainMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components });
      return existing;
    }
  }

  const msg = await channel.send({ embeds: [embed], components });
  await msg.pin().catch(() => {});
  setTimeout(() => deleteRecentSystemMessages(channel).catch(() => {}), 1500);

  setGuildConfig(guildId, {
    ...cfg,
    mainChannelId: channel.id,
    mainMessageId: msg.id,
  });

  return msg;
}

function buildDashboardAdminEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  return new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('📋 Dashboard admin Dragodinde')
    .setDescription('Vue admin de configuration du PMU Dragodinde.')
    .addFields(
      { name: 'Salon course / annonce', value: cfg.mainChannelId ? `<#${cfg.mainChannelId}>` : '—', inline: true },
      { name: 'Message principal', value: cfg.mainMessageId || '—', inline: true },
      { name: 'Salon logs', value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '—', inline: true },
      { name: 'Salon dashboard admin', value: cfg.dashboardChannelId ? `<#${cfg.dashboardChannelId}>` : '—', inline: true },
      { name: 'Rôle admin', value: cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '—', inline: true },
      { name: 'Rôle autorisé', value: cfg.allowedRoleIds?.length ? cfg.allowedRoleIds.map((rid) => `<@&${rid}>`).join(', ') : '—', inline: true },
    )
    .setFooter({ text: 'Le message PMU public est séparé du dashboard admin.' });
}

async function ensureDashboardPanel(channel, guildId) {
  const cfg = getGuildConfig(guildId);
  const embed = buildDashboardAdminEmbed(guildId);
  if (cfg.dashboardMessageId) {
    const existing = await channel.messages.fetch(cfg.dashboardMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components: [] });
      return existing;
    }
  }
  const msg = await channel.send({ embeds: [embed], components: [] });
  setGuildConfig(guildId, { ...cfg, dashboardMessageId: msg.id, dashboardChannelId: channel.id });
  return msg;
}

async function safeDeleteConfiguredMessage(client, channelId, messageId) {
  if (!channelId || !messageId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  if (!msg) return;
  await msg.unpin().catch(() => {});
  await msg.delete().catch(() => {});
}

async function refreshGuildMessages(client, guildId, cfg) {
  if (cfg.mainChannelId && cfg.mainMessageId) {
    const raceChannel = await client.channels.fetch(cfg.mainChannelId).catch(() => null);
    if (raceChannel && raceChannel.isTextBased()) {
      const raceMsg = await raceChannel.messages.fetch(cfg.mainMessageId).catch(() => null);
      if (raceMsg) {
        await raceMsg.edit({ embeds: [buildPanelEmbed()], components: joinButtonRow() }).catch(() => {});
      }
    }
  }

  if (cfg.dashboardChannelId && cfg.dashboardMessageId) {
    const dashChannel = await client.channels.fetch(cfg.dashboardChannelId).catch(() => null);
    if (dashChannel && dashChannel.isTextBased()) {
      const dashMsg = await dashChannel.messages.fetch(cfg.dashboardMessageId).catch(() => null);
      if (dashMsg) {
        await dashMsg.edit({ embeds: [buildDashboardAdminEmbed(guildId)], components: [] }).catch(() => {});
      }
    }
  }
}

async function onReady(client) {
  ensureDataDir();
  const config = loadConfig();
  const guildIds = Object.keys(config || {});
  for (const guildId of guildIds) {
    await refreshGuildMessages(client, guildId, config[guildId] || {}).catch(() => {});
  }
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
        .setLabel('Valider')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`dragodinde:setup:cancel:${guild.id}`)
        .setLabel('Annuler')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

async function showChannelSearchModal(interaction, type, guildId) {
  const safeType = type === 'logs' ? 'logs' : 'dashboard';
  const modal = new ModalBuilder()
    .setCustomId(`dragodinde:modalsearch:${safeType}:${guildId}`)
    .setTitle(safeType === 'logs' ? 'Rechercher salon logs' : 'Rechercher salon dashboard');

  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Nom du salon')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(safeType === 'logs' ? 'logs, pmu, courses...' : 'dashboard, dragodinde...')
    .setMaxLength(100);

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

async function updateWaitingRaceMessage(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state?.waitingMessageId) return;
  const msg = await channel.messages.fetch(state.waitingMessageId).catch(() => null);
  if (!msg) return;

  const remainingSeconds = Math.max(0, Math.ceil((state.deadlineAt - Date.now()) / 1000));
  await msg.edit({
    embeds: [buildRaceStatusEmbed('waiting', {
      creatorId: state.creatorId,
      humans: state.players,
      pot: REAL_BET * state.players.length,
      expectedHumans: state.expectedHumans,
      remainingSeconds,
    })],
  }).catch(() => {});
}

async function finalizeWaitingRace(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state || state.started) return;
  state.started = true;
  if (state.waitInterval) clearInterval(state.waitInterval);
  if (state.waitTimeout) clearTimeout(state.waitTimeout);

  if (!state.players.length) {
    raceStates.delete(guildId);
    return;
  }

  await runSimpleRace(channel, guildId);
}

async function startPlayersWait(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state) return;
  state.deadlineAt = Date.now() + WAIT_TIME_MS;

  const waitingMessage = await channel.send({
    embeds: [buildRaceStatusEmbed('waiting', {
      creatorId: state.creatorId,
      humans: state.players,
      pot: REAL_BET * state.players.length,
      expectedHumans: state.expectedHumans,
      remainingSeconds: Math.ceil(WAIT_TIME_MS / 1000),
    })],
  }).catch(() => null);

  if (waitingMessage) state.waitingMessageId = waitingMessage.id;

  state.waitInterval = setInterval(() => {
    updateWaitingRaceMessage(channel, guildId).catch(() => {});
  }, 3000);

  state.waitTimeout = setTimeout(() => {
    finalizeWaitingRace(channel, guildId).catch(() => {});
  }, WAIT_TIME_MS);
}

function generateTrack(contestants, positions) {
  return contestants.map((entry, rank) => {
    const horse = HORSES[entry.horseIndex];
    const pos = Math.max(0, Math.min(12, positions[entry.horseIndex] || 0));
    const before = '─'.repeat(pos);
    const after = '─'.repeat(12 - pos);
    const who = entry.userId ? `<@${entry.userId}>` : 'IA';
    return `${rank + 1}. ${horse.emoji} **${horse.name}** ${before}${horse.emoji}${after} ${who}`;
  }).join('\n');
}

function sortContestantsByProgress(contestants, positions) {
  return [...contestants].sort((a, b) => (positions[b.horseIndex] || 0) - (positions[a.horseIndex] || 0));
}

async function runCountdown(channel, seconds) {
  const msg = await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('⏳ Pré-départ')
      .setDescription(`La course démarre dans **${seconds}** secondes...`)
      .setColor(0x3498DB)
      .setImage(RACE_BANNER_URL)
      .setTimestamp()],
  }).catch(() => null);

  if (!msg) return;
  for (let s = seconds - 1; s >= 1; s--) {
    await new Promise((r) => setTimeout(r, 1000));
    await msg.edit({
      embeds: [new EmbedBuilder()
        .setTitle('⏳ Pré-départ')
        .setDescription(`La course démarre dans **${s}** secondes...`)
        .setColor(0x3498DB)
        .setImage(RACE_BANNER_URL)
        .setTimestamp()],
    }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1000));
  await msg.delete().catch(() => {});
}

async function createPayoutRecord(client, guildId, winner, totalAmount, participantsSnapshot) {
  const logsChannelId = getLogsChannelId(guildId);
  if (!logsChannelId || !winner?.userId) return null;
  const channel = await client.channels.fetch(logsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const recordId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const participantsText = participantsSnapshot.map((p) => `<@${p.userId}>`).join(', ') || 'Aucun';
  const horse = HORSES[winner.horseIndex];

  const embed = new EmbedBuilder()
    .setTitle('🏆 Gain à remettre')
    .setDescription(
      `**Gagnant :** <@${winner.userId}>\n` +
      `**Cheval :** ${horse.emoji} ${horse.name}\n` +
      `**Total à remettre :** ${Number(totalAmount).toLocaleString('fr-FR')} kamas\n` +
      `**Participants :** ${participantsText}\n` +
      `**Statut :** En attente de remise`
    )
    .setColor(0x2ECC71)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:payoutpay:${recordId}`).setLabel('Valider le gain').setStyle(ButtonStyle.Success)
  );

  const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (!msg) return null;

  const db = loadPayoutRecords();
  db[recordId] = {
    recordId,
    guildId,
    userId: String(winner.userId),
    horseIndex: winner.horseIndex,
    totalAmount: Number(totalAmount),
    participants: participantsSnapshot.map((p) => String(p.userId)),
    status: 'pending',
    channelId: channel.id,
    messageId: msg.id,
    createdAt: new Date().toISOString(),
    paidAt: null,
    paidByAdminId: null,
  };
  savePayoutRecords();
  return recordId;
}

async function runSimpleRace(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state) return;

  if (state.waitInterval) clearInterval(state.waitInterval);
  if (state.waitTimeout) clearTimeout(state.waitTimeout);

  const contestants = [...state.players];
  while (contestants.length < state.expectedHumans) {
    const used = new Set(contestants.map((p) => p.horseIndex));
    const available = HORSES.map((_, i) => i).filter((i) => !used.has(i));
    const horseIndex = available[Math.floor(Math.random() * available.length)] ?? 0;
    contestants.push({ userId: null, horseIndex, ai: true, joinedAt: Date.now() });
  }

  await channel.send({ embeds: [buildRaceStatusEmbed('launching', { creatorId: state.creatorId, humans: state.players, pot: REAL_BET * state.players.length })] }).catch(() => {});
  await runCountdown(channel, 5);

  const positions = Object.fromEntries(contestants.map((c) => [c.horseIndex, 0]));
  const raceMsg = await channel.send({
    content: `🏇 **Départ** 🏇\n${generateTrack(sortContestantsByProgress(contestants, positions), positions)}`,
  }).catch(() => null);

  let winner = null;
  while (!winner) {
    for (const contestant of contestants.sort(() => Math.random() - 0.5)) {
      positions[contestant.horseIndex] += Math.floor(Math.random() * 3) + 1;
      if (positions[contestant.horseIndex] >= 12) {
        positions[contestant.horseIndex] = 12;
        winner = contestant;
        break;
      }
    }

    const ordered = sortContestantsByProgress(contestants, positions);
    if (raceMsg) {
      await raceMsg.edit({
        content: `🏇 **Course en cours** 🏇\n${generateTrack(ordered, positions)}`,
      }).catch(() => {});
    }
    if (!winner) await new Promise((r) => setTimeout(r, 1500));
  }

  const pot = REAL_BET * state.players.length;
  await channel.send({
    embeds: [buildRaceStatusEmbed('finished', {
      humans: state.players,
      pot,
      winnerId: winner.userId,
      winnerName: HORSES[winner.horseIndex].name,
    })],
  }).catch(() => {});

  if (winner.userId) {
    await createPayoutRecord(channel.client, guildId, winner, pot, state.players).catch(() => {});
  }

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
      await interaction.reply({ content: 'Configure d’abord le salon dashboard admin avec /dragodinde_setup.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const channel = await interaction.client.channels.fetch(cfg.dashboardChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'Salon dashboard admin inaccessible.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const msg = await ensureDashboardPanel(channel, interaction.guild.id);
    await interaction.reply({ content: `✅ Dashboard admin Dragodinde prêt dans ${channel} (message ${msg.id}).`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.commandName === 'dragodinde_setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour utiliser cette commande.' });
      return true;
    }

    const guildId = interaction.guild.id;
    const cfg = getGuildConfig(guildId);
    const nextDraft = { ...cfg, mainChannelId: interaction.channelId };
    setupDrafts.set(guildId, nextDraft);

    await interaction.editReply({
      content: '### 🐎 Bienvenue dans la configuration du jeu\nLe message PMU sera créé dans ce salon après validation. Choisis les éléments ci-dessous puis valide.',
      components: buildSetupComponents(interaction.guild),
    });
    return true;
  }

  if (interaction.commandName === 'dragodinde_reset') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour utiliser cette commande.' });
      return true;
    }

    const guildId = interaction.guild.id;
    const cfg = getGuildConfig(guildId);

    await safeDeleteConfiguredMessage(interaction.client, cfg.mainChannelId, cfg.mainMessageId);
    await safeDeleteConfiguredMessage(interaction.client, cfg.dashboardChannelId, cfg.dashboardMessageId);

    setupDrafts.delete(guildId);
    raceStates.delete(guildId);

    setGuildConfig(guildId, {
      logsChannelId: null,
      dashboardChannelId: null,
      adminRoleId: null,
      notificationRoleId: null,
      allowedRoleIds: [],
      dashboardMessageId: null,
      mainChannelId: null,
      mainMessageId: null,
    });

    await interaction.editReply({ content: '✅ Dragodinde a été réinitialisé. Les messages créés par le setup ont été supprimés.' });
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
    const parts = interaction.customId.split(':');
    const type = parts[2];
    const guildId = parts[3];
    if (!interaction.guild || interaction.guild.id !== guildId) return false;
    try {
      await showChannelSearchModal(interaction, type, guildId);
    } catch (error) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `Impossible d'ouvrir la recherche de salon: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
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

    if (mode === 'players') {
      await interaction.update({
        content: 'Choisis combien d’adversaires tu veux provoquer.',
        components: playerCountRows(userId),
      });
      return true;
    }

    await interaction.update({
      content: `Mode sélectionné : **Contre l\'IA**\nChoisis maintenant ta Dragodinde.`,
      components: horseChoiceRows(userId, mode),
    });
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:count:')) {
    const [, , countRaw, userId] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const session = userSessions.get(userId) || {};
    session.expectedHumans = Math.min(MAX_PLAYERS, Math.max(2, Number(countRaw) + 1));
    userSessions.set(userId, session);
    await interaction.update({
      content: `Tu veux une course contre **${countRaw}** adversaire(s). Choisis maintenant ta Dragodinde.`,
      components: horseChoiceRows(userId, 'players'),
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

    const [allowedToPlay, blockedReason] = canUserPlay(interaction.member);
    if (!allowedToPlay) {
      await interaction.reply({ content: blockedReason, flags: MessageFlags.Ephemeral });
      return true;
    }

    if (mode === 'ia') {
      const debtRecordId = await createDebtRecord(interaction.client, guildId, interaction.user.id, horseIndex, ENTRY_FEE, { mode: 'ia', formulaLabel: 'Formule IA temporaire' });
      if (!debtRecordId) {
        await interaction.reply({ content: 'Impossible de créer l’engagement de paiement. Vérifie le salon logs.', flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.update({
        content: `✅ Tu as choisi **${horse.emoji} ${horse.name}** pour affronter l’IA. La course démarre...`,
        components: [],
      });
      raceStates.set(guildId, {
        creatorId: interaction.user.id,
        players: [{ userId: interaction.user.id, horseIndex, ai: false, joinedAt: Date.now(), debtRecordId }],
        expectedHumans: MAX_PLAYERS,
        started: false,
      });
      await runSimpleRace(interaction.channel, guildId);
      return true;
    }

    const session = userSessions.get(userId) || {};
    const existing = raceStates.get(guildId);

    if (existing && !existing.started) {
      if (existing.players.find((p) => p.userId === interaction.user.id)) {
        await interaction.reply({ content: 'Tu es déjà inscrit à cette course.', flags: MessageFlags.Ephemeral });
        return true;
      }
      if (existing.players.find((p) => p.horseIndex === horseIndex)) {
        await interaction.reply({ content: 'Cette dragodinde est déjà prise. Choisis-en une autre.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const debtRecordId = await createDebtRecord(interaction.client, guildId, interaction.user.id, horseIndex, ENTRY_FEE, { mode: 'players' });
      if (!debtRecordId) {
        await interaction.reply({ content: 'Impossible de créer l’engagement de paiement. Vérifie le salon logs.', flags: MessageFlags.Ephemeral });
        return true;
      }

      existing.players.push({ userId: interaction.user.id, horseIndex, ai: false, joinedAt: Date.now(), debtRecordId });
      raceStates.set(guildId, existing);

      await interaction.update({
        content: `✅ Tu rejoins la course en attente avec **${horse.emoji} ${horse.name}**.`,
        components: [],
      });

      await interaction.followUp({
        content: `Tu peux annuler pendant **${Math.floor(CANCEL_WINDOW_MS / 1000)} secondes**.`,
        components: cancelParticipationRows(userId),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});

      await updateWaitingRaceMessage(interaction.channel, guildId);

      if (existing.players.length >= existing.expectedHumans) {
        await finalizeWaitingRace(interaction.channel, guildId);
      }
      return true;
    }

    const debtRecordId = await createDebtRecord(interaction.client, guildId, interaction.user.id, horseIndex, ENTRY_FEE, { mode: 'players' });
    if (!debtRecordId) {
      await interaction.reply({ content: 'Impossible de créer l’engagement de paiement. Vérifie le salon logs.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const expectedHumans = session.expectedHumans || 2;
    const state = {
      creatorId: interaction.user.id,
      players: [{ userId: interaction.user.id, horseIndex, ai: false, joinedAt: Date.now(), debtRecordId }],
      expectedHumans,
      started: false,
    };
    raceStates.set(guildId, state);

    await interaction.update({
      content: `✅ Tu es inscrit avec **${horse.emoji} ${horse.name}**.\nLa recherche de joueurs commence...`,
      components: [],
    });

    await startPlayersWait(interaction.channel, guildId);

    await interaction.followUp({
      content: `Recherche d'adversaires lancée. Tu peux annuler pendant **${Math.floor(CANCEL_WINDOW_MS / 1000)} secondes**.`,
      components: cancelParticipationRows(userId),
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:cancel:')) {
    const [, , userId] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const guildId = interaction.guild.id;
    const state = raceStates.get(guildId);
    if (!state || state.started) {
      await interaction.reply({ content: 'Il n’y a plus de course en attente à annuler.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const player = state.players.find((p) => p.userId === userId);
    if (!player) {
      await interaction.reply({ content: 'Tu n’es plus inscrit à cette course.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (Date.now() - (player.joinedAt || 0) > CANCEL_WINDOW_MS) {
      await interaction.reply({ content: 'Le délai d’annulation est dépassé.', flags: MessageFlags.Ephemeral });
      return true;
    }

    state.players = state.players.filter((p) => p.userId !== userId);
    if (player.debtRecordId) {
      await markDebtCancelled(interaction.client, player.debtRecordId, userId).catch(() => {});
    }

    if (!state.players.length || state.creatorId === userId) {
      if (state.waitInterval) clearInterval(state.waitInterval);
      if (state.waitTimeout) clearTimeout(state.waitTimeout);
      raceStates.delete(guildId);
      if (state.waitingMessageId) {
        const msg = await interaction.channel.messages.fetch(state.waitingMessageId).catch(() => null);
        if (msg) {
          await msg.delete().catch(() => {});
        }
      }
      await interaction.update({ content: 'Participation annulée, la recherche est fermée.', components: [] });
      return true;
    }

    raceStates.set(guildId, state);
    await interaction.update({ content: 'Ta participation a été annulée.', components: [] });
    await updateWaitingRaceMessage(interaction.channel, guildId);
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:debtpay:')) {
    const [, , recordId] = interaction.customId.split(':');
    const db = loadDebtRecords();
    const record = db[recordId];
    if (!record) {
      await interaction.reply({ content: 'Enregistrement introuvable.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const adminRoleId = getAdminRoleId(interaction.guild.id);
    const allowed = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || (adminRoleId && interaction.member?.roles?.cache?.has(adminRoleId));
    if (!allowed) {
      await interaction.reply({ content: 'Rôle admin requis.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (record.status === 'paid') {
      await interaction.reply({ content: 'Ce paiement est déjà validé.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (record.status === 'cancelled') {
      await interaction.reply({ content: 'Cet engagement a déjà été annulé.', flags: MessageFlags.Ephemeral });
      return true;
    }

    record.status = 'paid';
    record.paidAt = new Date().toISOString();
    record.paidByAdminId = interaction.user.id;
    saveDebtRecords();
    applyUserPayment(record.userId, record.amount);

    const existingEmbed = interaction.message.embeds?.[0];
    if (existingEmbed) {
      const embed = EmbedBuilder.from(existingEmbed)
        .setColor(0x2ECC71)
        .setDescription((existingEmbed.description || '').replace('En attente de paiement', 'Payé'))
        .setFooter({ text: `Validé par ${interaction.user.displayName}` });
      await interaction.update({ embeds: [embed], components: [] });
    } else {
      await interaction.update({ components: [] });
    }
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:payoutpay:')) {
    const [, , recordId] = interaction.customId.split(':');
    const db = loadPayoutRecords();
    const record = db[recordId];
    if (!record) {
      await interaction.reply({ content: 'Enregistrement de gain introuvable.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const adminRoleId = getAdminRoleId(interaction.guild.id);
    const allowed = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || (adminRoleId && interaction.member?.roles?.cache?.has(adminRoleId));
    if (!allowed) {
      await interaction.reply({ content: 'Rôle admin requis.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (record.status === 'paid') {
      await interaction.reply({ content: 'Ce gain est déjà validé.', flags: MessageFlags.Ephemeral });
      return true;
    }

    record.status = 'paid';
    record.paidAt = new Date().toISOString();
    record.paidByAdminId = interaction.user.id;
    savePayoutRecords();

    const existingEmbed = interaction.message.embeds?.[0];
    if (existingEmbed) {
      const embed = EmbedBuilder.from(existingEmbed)
        .setColor(0x3498DB)
        .setDescription((existingEmbed.description || '').replace('En attente de remise', 'Gain remis'))
        .setFooter({ text: `Gain validé par ${interaction.user.displayName}` });
      await interaction.update({ embeds: [embed], components: [] });
    } else {
      await interaction.update({ components: [] });
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
    const saved = { ...getGuildConfig(guildId), ...draft };
    setGuildConfig(guildId, saved);

    if (saved.mainChannelId) {
      const raceChannel = await interaction.client.channels.fetch(saved.mainChannelId).catch(() => null);
      if (raceChannel && raceChannel.isTextBased()) {
        const msg = await ensurePinnedRaceMessage(raceChannel, guildId);
        saved.mainMessageId = msg.id;
        setGuildConfig(guildId, saved);
      }
    }

    if (saved.dashboardChannelId) {
      const dashboardChannel = await interaction.client.channels.fetch(saved.dashboardChannelId).catch(() => null);
      if (dashboardChannel && dashboardChannel.isTextBased()) {
        const dashMsg = await ensureDashboardPanel(dashboardChannel, guildId);
        saved.dashboardMessageId = dashMsg.id;
        setGuildConfig(guildId, saved);
      }
    }

    await interaction.update({
      content:
        'Configuration Dragodinde enregistrée.\n' +
        `• Salon course / annonce: ${saved.mainChannelId ? `<#${saved.mainChannelId}>` : '—'}\n` +
        `• Logs: ${saved.logsChannelId ? `<#${saved.logsChannelId}>` : '—'}\n` +
        `• Dashboard admin: ${saved.dashboardChannelId ? `<#${saved.dashboardChannelId}>` : '—'}\n` +
        `• Admin: ${saved.adminRoleId ? `<@&${saved.adminRoleId}>` : '—'}\n` +
        `• Rôle autorisé: ${saved.allowedRoleIds?.length ? saved.allowedRoleIds.map((rid) => `<@&${rid}>`).join(', ') : '—'}\n\n` +
        'Le message PMU public a été placé dans le salon où tu as lancé /dragodinde_setup.',
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
