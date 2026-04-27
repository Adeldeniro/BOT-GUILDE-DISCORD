const fs = require('fs');
const path = require('path');
const https = require('https');
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
let HORSES = [
  { name: 'Tonnerre', emoji: '🐎' },
  { name: 'Éclair', emoji: '⚡' },
  { name: 'Foudre', emoji: '🌩️' },
  { name: 'Tempête', emoji: '🌊' },
];

const setupDrafts = new Map();
const userSessions = new Map();
const raceStates = new Map();
const reopenCountdowns = new Map();
const WAIT_TIME_MS = 45_000;
const CANCEL_WINDOW_MS = 15_000;
const REOPEN_COUNTDOWN_MS = 15_000;
const THREAD_LIFETIME_MS = 25_000;
const MAIN_COUNTDOWN_MS = 15_000;
const RACE_TICK_MS = 2_500;
const IA_BALANCE = {
  1: { aiBoost: 0.15, humanNerf: 0.0 },
  2: { aiBoost: 0.30, humanNerf: 0.05 },
  3: { aiBoost: 0.55, humanNerf: 0.10 },
};
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
    horseEmojis: null,
    entriesClosed: false,
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

function getAllowedRolesFromConfig(cfg) {
  return [
    ...(Array.isArray(cfg.allowedRoleIds) ? cfg.allowedRoleIds : []),
    cfg.notificationRoleId || null,
    '1480657602382790903',
  ].filter(Boolean);
}

function normalizeEmoji(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  const fullCustom = value.match(/^<(a?):([\w~]+):(\d+)>$/);
  if (fullCustom) {
    const animated = fullCustom[1] === 'a';
    return { id: fullCustom[3], name: fullCustom[2], animated, mention: `<${animated ? 'a' : ''}:${fullCustom[2]}:${fullCustom[3]}>` };
  }

  const looseCustom = value.match(/^:([\w~]+):$/);
  if (looseCustom) {
    return { name: looseCustom[1], mention: `:${looseCustom[1]}:` };
  }

  const idNameCustom = value.match(/^([\w~]+):(\d+)$/);
  if (idNameCustom) {
    return { id: idNameCustom[2], name: idNameCustom[1], animated: false, mention: `<:${idNameCustom[1]}:${idNameCustom[2]}>` };
  }

  return { name: value, mention: value };
}

function emojiForButton(raw) {
  const emoji = normalizeEmoji(raw);
  if (!emoji) return '🐎';
  return emoji.id ? { id: emoji.id, name: emoji.name, animated: !!emoji.animated } : emoji.name;
}

function emojiForText(raw) {
  const emoji = normalizeEmoji(raw);
  return emoji?.mention || '🐎';
}

function refreshHorseEmojisFromConfig(guildId) {
  const cfg = getGuildConfig(guildId);
  const emojis = Array.isArray(cfg.horseEmojis) && cfg.horseEmojis.length === 4 ? cfg.horseEmojis : null;
  if (!emojis) return;
  HORSES = [
    { ...HORSES[0], emoji: emojis[0] || HORSES[0].emoji },
    { ...HORSES[1], emoji: emojis[1] || HORSES[1].emoji },
    { ...HORSES[2], emoji: emojis[2] || HORSES[2].emoji },
    { ...HORSES[3], emoji: emojis[3] || HORSES[3].emoji },
  ];
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
    db[userId] = { totalDebt: 0, betsCount: 0, paymentsCount: 0, payoutsPending: 0, payoutsValidated: 0, totalWinnings: 0 };
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

function removeUserDebt(userId, amount) {
  const db = loadFinance();
  const current = getUserFinance(String(userId));
  current.totalDebt = Math.max(0, Number(current.totalDebt || 0) - Number(amount || 0));
  db[String(userId)] = current;
  saveFinance();
}

function registerPendingPayout(userId, amount) {
  const db = loadFinance();
  const current = getUserFinance(String(userId));
  current.payoutsPending = Number(current.payoutsPending || 0) + 1;
  db[String(userId)] = current;
  saveFinance();
}

function validateUserPayout(userId, amount) {
  const db = loadFinance();
  const current = getUserFinance(String(userId));
  current.payoutsPending = Math.max(0, Number(current.payoutsPending || 0) - 1);
  current.payoutsValidated = Number(current.payoutsValidated || 0) + 1;
  current.totalWinnings = Number(current.totalWinnings || 0) + Number(amount || 0);
  db[String(userId)] = current;
  saveFinance();
}

function canUserPlay(member) {
  if (!member) return [false, 'Membre introuvable.'];
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return [true, null];

  const cfg = getGuildConfig(member.guild.id);
  const allowedRoles = getAllowedRolesFromConfig(cfg);

  if (allowedRoles.length) {
    const memberRoleIds = new Set(member.roles?.cache?.map((role) => role.id) || []);
    const allowed = allowedRoles.some((rid) => memberRoleIds.has(rid));
    if (!allowed) {
      return [false, `Tu n’as pas le rôle autorisé pour jouer à cette course. Rôles acceptés: ${allowedRoles.join(', ')}`];
    }
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
      `**Cheval :** ${emojiForText(HORSES[horseIndex].emoji)} ${HORSES[horseIndex].name}\n` +
      `**Dette totale après inscription :** ${futureTotal.toLocaleString('fr-FR')} kamas\n` +
      `**Statut :** En attente de paiement`
    )
    .setColor(0xFFA500)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:debtpay:${recordId}`).setLabel('Valider le paiement').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dragodinde:debtpaid:${recordId}`).setLabel('Dette payée').setStyle(ButtonStyle.Primary)
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
  removeUserDebt(record.userId, record.amount);

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

async function deleteRecentSystemMessages(channel) {
  if (!channel?.messages?.fetch) return;
  const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
  if (!messages) return;
  for (const msg of messages.values()) {
    if (msg.system || msg.type !== 0) {
      await msg.delete().catch(() => {});
    }
  }
}

async function reopenParticipationCountdown(channel, guildId) {
  const existing = reopenCountdowns.get(guildId);
  if (existing?.timeout) clearTimeout(existing.timeout);
  if (existing?.interval) clearInterval(existing.interval);

  let remaining = Math.ceil(REOPEN_COUNTDOWN_MS / 1000);
  const msg = await channel.send({ content: `🎟️ Nouvelle participation disponible dans **${remaining}** secondes.` }).catch(() => null);
  if (!msg) return;

  const interval = setInterval(async () => {
    remaining -= 1;
    if (remaining <= 0) return;
    await msg.edit({ content: `🎟️ Nouvelle participation disponible dans **${remaining}** secondes.` }).catch(() => {});
  }, 1000);

  const timeout = setTimeout(async () => {
    clearInterval(interval);
    reopenCountdowns.delete(guildId);
    await msg.delete().catch(() => {});
    await deleteRecentSystemMessages(channel).catch(() => {});

    const cfg = getGuildConfig(guildId);
    if (cfg.mainMessageId) {
      const mainMsg = await channel.messages.fetch(cfg.mainMessageId).catch(() => null);
      if (mainMsg) {
        const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        if (recent) {
          for (const candidate of recent.values()) {
            if (candidate.id !== mainMsg.id && candidate.id !== msg.id && !candidate.pinned) {
              await candidate.delete().catch(() => {});
            }
          }
        }
      }
    }

    await refreshGuildMessages(channel.client, guildId, getGuildConfig(guildId)).catch(() => {});
  }, REOPEN_COUNTDOWN_MS);

  reopenCountdowns.set(guildId, { interval, timeout, messageId: msg.id });
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
    new SlashCommandBuilder()
      .setName('dragodinde_refresh')
      .setDescription('Rafraîchir l’annonce PMU et le dashboard admin'),
    new SlashCommandBuilder()
      .setName('dragodinde_close')
      .setDescription('Fermer temporairement les participations Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_open')
      .setDescription('Rouvrir les participations Dragodinde'),
    new SlashCommandBuilder()
      .setName('dragodinde_cancel_race')
      .setDescription('Annuler la course en attente en cours'),
    new SlashCommandBuilder()
      .setName('dragodinde_soft_reset')
      .setDescription('Réinitialiser uniquement l’état temporaire de course'),
    new SlashCommandBuilder()
      .setName('set_emojis_dragodinde')
      .setDescription('Modifier les emojis des 4 dragodindes')
      .addStringOption((option) => option.setName('emoji1').setDescription('Emoji dragodinde 1').setRequired(true))
      .addStringOption((option) => option.setName('emoji2').setDescription('Emoji dragodinde 2').setRequired(true))
      .addStringOption((option) => option.setName('emoji3').setDescription('Emoji dragodinde 3').setRequired(true))
      .addStringOption((option) => option.setName('emoji4').setDescription('Emoji dragodinde 4').setRequired(true)),
    new SlashCommandBuilder()
      .setName('dragodinde_import_emojis')
      .setDescription('Importer 4 emojis custom dans ce serveur et les assigner aux dragodindes')
      .addStringOption((option) => option.setName('emoji1').setDescription('Emoji source 1, ex <:DD1:123>').setRequired(true))
      .addStringOption((option) => option.setName('emoji2').setDescription('Emoji source 2, ex <:DD2:123>').setRequired(true))
      .addStringOption((option) => option.setName('emoji3').setDescription('Emoji source 3, ex <:DD3:123>').setRequired(true))
      .addStringOption((option) => option.setName('emoji4').setDescription('Emoji source 4, ex <:DD4:123>').setRequired(true)),
  ];
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function importGuildEmoji(guild, rawEmoji, fallbackName) {
  const parsed = normalizeEmoji(rawEmoji);
  if (!parsed?.id || !parsed?.name) throw new Error(`Emoji source invalide: ${rawEmoji}`);

  const existing = guild.emojis.cache.find((emoji) => emoji.name === parsed.name);
  if (existing) return `<${existing.animated ? 'a' : ''}:${existing.name}:${existing.id}>`;

  const ext = parsed.animated ? 'gif' : 'png';
  const url = `https://cdn.discordapp.com/emojis/${parsed.id}.${ext}?quality=lossless`;
  const buffer = await downloadBuffer(url);
  const created = await guild.emojis.create({ attachment: buffer, name: parsed.name || fallbackName });
  return `<${created.animated ? 'a' : ''}:${created.name}:${created.id}>`;
}

function joinButtonRow() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dragodinde:join:main').setLabel('Participer').setEmoji('🐎').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('dragodinde:notify:toggle').setLabel('Notifications').setEmoji('🔔').setStyle(ButtonStyle.Secondary)
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

function iaBetRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:iabet:1:${userId}`).setLabel('Double ta mise').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dragodinde:iabet:2:${userId}`).setLabel('Triple ta mise').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dragodinde:iabet:3:${userId}`).setLabel('Jackpot 2M').setStyle(ButtonStyle.Danger)
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
      .setCustomId(`dragodinde:horse:${mode}:${userId}:${i}`)
      .setLabel(horse.name)
      .setEmoji(emojiForButton(horse.emoji))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(waiting && taken.has(i)))
  )];
}

function cancelParticipationRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:cancel:${userId}`).setLabel('Annuler ma participation').setStyle(ButtonStyle.Danger)
  )];
}

function iaConfirmRows(userId, horseIndex) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:iaconfirm:yes:${userId}:${horseIndex}`).setLabel('Confirmer la mise').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dragodinde:iaconfirm:no:${userId}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
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
        { name: 'Joueurs engagés', value: humans.length ? humans.map((p) => `${emojiForText(HORSES[p.horseIndex].emoji)} <@${p.userId}> avec **${HORSES[p.horseIndex].name}**`).join('\n') : 'Aucun', inline: false },
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

function sumAmounts(records, predicate = () => true, field = 'amount') {
  return Object.values(records || {}).reduce((sum, record) => {
    if (!predicate(record)) return sum;
    return sum + Number(record?.[field] || 0);
  }, 0);
}

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString('fr-FR')} kamas`;
}

function topEntriesFromFinance(selector, limit = 5) {
  return Object.entries(loadFinance())
    .map(([userId, data]) => ({ userId, value: Number(selector(data) || 0) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function formatTopList(entries, formatter = (entry) => formatMoney(entry.value)) {
  if (!entries.length) return 'Aucun';
  return entries.map((entry, index) => `${index + 1}. <@${entry.userId}> , ${formatter(entry)}`).join('\n');
}

function pendingDebtLines() {
  const debts = Object.values(loadDebtRecords())
    .filter((record) => record.status === 'unpaid')
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
    .slice(0, 10);

  if (!debts.length) return 'Aucune dette en attente';
  return debts.map((record) => {
    const formula = record.formulaLabel ? `, ${record.formulaLabel}` : record.mode ? `, ${record.mode}` : '';
    return `• <@${record.userId}> , ${formatMoney(record.amount)}${formula}`;
  }).join('\n');
}

function pendingPayoutLines() {
  const payouts = Object.values(loadPayoutRecords())
    .filter((record) => record.status === 'pending')
    .sort((a, b) => Number(b.totalAmount || 0) - Number(a.totalAmount || 0))
    .slice(0, 10);

  if (!payouts.length) return 'Aucun gain en attente';
  return payouts.map((record) => `• <@${record.userId}> , ${formatMoney(record.totalAmount)}`).join('\n');
}

function buildDashboardAdminEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  const debts = loadDebtRecords();
  const payouts = loadPayoutRecords();
  const financeDb = loadFinance();
  const state = raceStates.get(guildId);

  const unpaidDebtCount = Object.values(debts).filter((record) => record.status === 'unpaid' && record.guildId === guildId).length;
  const unpaidDebtTotal = sumAmounts(debts, (record) => record.status === 'unpaid' && record.guildId === guildId, 'amount');
  const pendingPayoutCount = Object.values(payouts).filter((record) => record.status === 'pending' && record.guildId === guildId).length;
  const pendingPayoutTotal = sumAmounts(payouts, (record) => record.status === 'pending' && record.guildId === guildId, 'totalAmount');
  const paidPayoutTotal = sumAmounts(payouts, (record) => record.status === 'paid' && record.guildId === guildId, 'totalAmount');
  const totalBets = Object.values(financeDb).reduce((sum, item) => sum + Number(item.betsCount || 0), 0);
  const totalPayments = Object.values(financeDb).reduce((sum, item) => sum + Number(item.paymentsCount || 0), 0);
  const totalWinnings = Object.values(financeDb).reduce((sum, item) => sum + Number(item.totalWinnings || 0), 0);

  const topDebtors = topEntriesFromFinance((data) => data.totalDebt, 5);
  const topWinners = topEntriesFromFinance((data) => data.totalWinnings, 5);
  const topActive = topEntriesFromFinance((data) => data.betsCount, 5);

  const liveState = cfg.entriesClosed
    ? 'Fermé manuellement, le tiroir-caisse prend l’air'
    : !state
      ? 'Repos'
      : state.started
        ? 'Course en cours, les kamas transpirent'
        : state.players?.length
          ? `Préparation / attente (${state.players.length} inscrit(s))`
          : 'Préparation';

  return new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('📋 Dashboard admin Dragodinde')
    .setDescription('Vue globale finance + état live du PMU Dragodinde.')
    .addFields(
      { name: 'État live', value: liveState, inline: true },
      { name: 'Salon course / annonce', value: cfg.mainChannelId ? `<#${cfg.mainChannelId}>` : '—', inline: true },
      { name: 'Salon logs', value: cfg.logsChannelId ? `<#${cfg.logsChannelId}>` : '—', inline: true },
      { name: 'Dette totale en attente', value: formatMoney(unpaidDebtTotal), inline: true },
      { name: 'Dettes impayées', value: String(unpaidDebtCount), inline: true },
      { name: 'Gains en attente', value: `${pendingPayoutCount} , ${formatMoney(pendingPayoutTotal)}`, inline: true },
      { name: 'Gains validés', value: formatMoney(paidPayoutTotal), inline: true },
      { name: 'Total redistribué', value: formatMoney(totalWinnings), inline: true },
      { name: 'Participations loggées', value: String(totalBets), inline: true },
      { name: 'Paiements validés', value: String(totalPayments), inline: true },
      { name: 'Dettes en attente (personnes concernées)', value: pendingDebtLines(), inline: false },
      { name: 'Gains en attente (personnes concernées)', value: pendingPayoutLines(), inline: false },
      { name: 'Top débiteurs', value: formatTopList(topDebtors), inline: false },
      { name: 'Top gagnants', value: formatTopList(topWinners), inline: false },
      { name: 'Joueurs les plus actifs', value: formatTopList(topActive, (entry) => `${entry.value} participation(s)`), inline: false },
      { name: 'Rôle admin', value: cfg.adminRoleId ? `<@&${cfg.adminRoleId}>` : '—', inline: true },
      { name: 'Rôle autorisé', value: cfg.allowedRoleIds?.length ? cfg.allowedRoleIds.map((rid) => `<@&${rid}>`).join(', ') : '—', inline: true },
      { name: 'Message principal', value: cfg.mainMessageId || '—', inline: true },
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
    refreshHorseEmojisFromConfig(guildId);
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

async function createRaceThread(channel, prefix) {
  const starter = await channel.send({ content: '🏇' }).catch(() => null);
  if (!starter) return { starter: null, thread: null };

  const thread = await starter.startThread({
    name: `${prefix}-${Math.floor(Date.now() / 1000)}`,
    autoArchiveDuration: 60,
  }).catch(() => null);

  setTimeout(() => deleteRecentSystemMessages(channel).catch(() => {}), 1200);
  return { starter, thread };
}

async function updateRaceWatchMessage(channel, thread, label = 'Regarder la course') {
  if (!thread) return null;
  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${channel.guild.id}/${thread.id}`)
  );
  return channel.send({ content: '🎟️ La course est prête.', components: [button] }).catch(() => null);
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

function buildTrackBar(emojiRaw, progress, length = 14) {
  const horseEmoji = emojiForText(emojiRaw);
  const slot = Math.max(0, Math.min(length - 1, Math.round(progress * (length - 1))));
  const cells = Array.from({ length }, (_, index) => {
    if (index === 0) return '🏁';
    if (index === length - 1) return '💰';
    if (index === slot) return horseEmoji;
    return '═';
  });
  return cells.join('');
}

function raceEventLine(ordered, positions) {
  const leader = ordered[0];
  const chaser = ordered[1];
  if (!leader) return 'Le silence règne, ce qui est mauvais signe pour tout le monde.';

  const leaderHorse = HORSES[leader.horseIndex];
  const leaderPct = Math.round(Math.max(0, Math.min(1, (positions[leader.horseIndex] || 0) / 20)) * 100);
  if (!chaser) return `${emojiForText(leaderHorse.emoji)} **${leaderHorse.name}** trotte seule vers la caisse, quelle indécence.`;

  const chaserHorse = HORSES[chaser.horseIndex];
  const gap = (positions[leader.horseIndex] || 0) - (positions[chaser.horseIndex] || 0);
  if (gap <= 1) return `⚠️ **${leaderHorse.name}** et **${chaserHorse.name}** sont roue dans roue, ça sent la panique et les paris de dernière minute.`;
  if (leaderPct >= 80) return `🔥 **${leaderHorse.name}** approche du pactole pendant que **${chaserHorse.name}** découvre le goût du seum.`;
  return `🎙️ **${leaderHorse.name}** tient la corde, mais **${chaserHorse.name}** refuse encore de mourir proprement.`;
}

function generateTrack(contestants, positions) {
  const fence = '🪵🪵🪵🪵🪵🪵🪵🪵🪵🪵';
  return contestants.map((entry, rank) => {
    const horse = HORSES[entry.horseIndex];
    const progress = Math.max(0, Math.min(1, (positions[entry.horseIndex] || 0) / 20));
    const who = entry.userId ? `<@${entry.userId}>` : 'IA';
    const pace = Math.round(progress * 100);
    return [
      `**${rank + 1}. ${horse.name}** , ${who}`,
      `${buildTrackBar(horse.emoji, progress)} **${pace}%**`,
      fence,
    ].join('\n');
  }).join('\n\n');
}

function sortContestantsByProgress(contestants, positions) {
  return [...contestants].sort((a, b) => (positions[b.horseIndex] || 0) - (positions[a.horseIndex] || 0));
}

async function runCountdown(channel, seconds, title = '⏳ Pré-départ', textPrefix = 'La course démarre dans') {
  const msg = await channel.send({ content: `${title} ${textPrefix} **${seconds}** secondes...` }).catch(() => null);

  if (!msg) return null;
  for (let s = seconds - 1; s >= 1; s--) {
    await new Promise((r) => setTimeout(r, 1000));
    await msg.edit({ content: `${title} ${textPrefix} **${s}** secondes...` }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 1000));
  return msg;
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
      `**Cheval :** ${emojiForText(horse.emoji)} ${horse.name}\n` +
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
  registerPendingPayout(winner.userId, totalAmount);
  return recordId;
}

async function runSimpleRace(channel, guildId) {
  const state = raceStates.get(guildId);
  if (!state) return;

  if (state.waitInterval) clearInterval(state.waitInterval);
  if (state.waitTimeout) clearTimeout(state.waitTimeout);
  state.started = true;

  const contestants = [...state.players];
  while (contestants.length < state.expectedHumans) {
    const used = new Set(contestants.map((p) => p.horseIndex));
    const available = HORSES.map((_, i) => i).filter((i) => !used.has(i));
    const horseIndex = available[Math.floor(Math.random() * available.length)] ?? 0;
    contestants.push({ userId: null, horseIndex, ai: true, joinedAt: Date.now() });
  }

  const pot = state.iaPrize || (REAL_BET * state.players.length);
  const launchingMsg = await channel.send({ embeds: [buildRaceStatusEmbed('launching', { creatorId: state.creatorId, humans: state.players, pot })] }).catch(() => null);
  const mainCountdownMsg = await runCountdown(channel, Math.ceil(MAIN_COUNTDOWN_MS / 1000), '📣 Mise en piste', 'Ouverture du fil de course dans');
  if (mainCountdownMsg) await mainCountdownMsg.delete().catch(() => {});

  const made = await createRaceThread(channel, contestants.some((c) => c.userId) && contestants.some((c) => !c.userId) ? 'course-mixte' : 'course');
  const starter = made.starter;
  const thread = made.thread;
  const raceRoom = thread || channel;

  if (thread) {
    const watchMsg = await updateRaceWatchMessage(channel, thread, 'Regarder la course').catch(() => null);
    state.watchMessageId = watchMsg?.id || null;
    await raceRoom.send({
      embeds: [new EmbedBuilder()
        .setTitle('🏇 Course Dragodinde')
        .setDescription(`Participants :\n${state.players.map((p) => `${emojiForText(HORSES[p.horseIndex].emoji)} <@${p.userId}> avec **${HORSES[p.horseIndex].name}**`).join('\n')}\n\nAdversaires IA : ${contestants.filter((c) => !c.userId).length}`)
        .setColor(0x3498DB)
        .setImage(RACE_BANNER_URL)
        .setTimestamp()],
    }).catch(() => {});
  }

  const threadCountdownMsg = await runCountdown(raceRoom, 5, '⏳ Pré-départ', 'La course démarre dans');
  if (threadCountdownMsg) await threadCountdownMsg.delete().catch(() => {});

  const FINISH_LINE = 20;
  const positions = Object.fromEntries(contestants.map((c) => [c.horseIndex, 0]));
  const raceMsg = await raceRoom.send({
    content: `🎬 **Les paris sont posés, les ego aussi**\n${generateTrack(sortContestantsByProgress(contestants, positions), positions)}\n\n🎙️ Le départ est donné, et déjà quelqu’un va regretter d’avoir ouvert son portefeuille.`,
  }).catch(() => null);

  const hasAiRace = !!state.iaPrize;
  const iaTier = Number(state.expectedHumans || 2) - 1;
  const iaBalance = IA_BALANCE[iaTier] || { aiBoost: 0, humanNerf: 0 };

  let winner = null;
  let tick = 0;
  while (!winner) {
    tick += 1;
    const orderedBefore = sortContestantsByProgress(contestants, positions);
    for (const contestant of contestants.sort(() => Math.random() - 0.5)) {
      let step = Math.floor(Math.random() * 2) + 1;
      const current = positions[contestant.horseIndex] || 0;
      const leader = Math.max(...contestants.map((c) => positions[c.horseIndex] || 0));
      const gap = leader - current;
      const isAi = !contestant.userId;

      if (gap >= 4 && Math.random() < 0.60) step += 2;
      if (gap >= 2 && Math.random() < 0.45) step += 1;
      if (current >= 14 && Math.random() < 0.40) step = Math.max(1, step - 1);
      if (tick >= 5 && Math.random() < 0.22) step += 1;

      if (hasAiRace) {
        if (isAi && Math.random() < iaBalance.aiBoost) step += 1;
        if (!isAi && Math.random() < iaBalance.humanNerf) step = Math.max(1, step - 1);
      }

      positions[contestant.horseIndex] += step;
      if (positions[contestant.horseIndex] >= FINISH_LINE) {
        positions[contestant.horseIndex] = FINISH_LINE;
        winner = contestant;
        break;
      }
    }

    const ordered = sortContestantsByProgress(contestants, positions);
    const leaderChanged = orderedBefore[0]?.horseIndex !== ordered[0]?.horseIndex;
    const title = leaderChanged ? '💥 **Renversement de situation** 💥' : tick >= 6 ? '🔥 **Dernière ligne droite** 🔥' : '🏇 **La piste s’embrase** 🏇';
    const eventText = raceEventLine(ordered, positions);
    if (raceMsg) {
      await raceMsg.edit({
        content: `${title}\n${generateTrack(ordered, positions)}\n\n${eventText}`,
      }).catch(() => {});
    }
    if (!winner) await new Promise((r) => setTimeout(r, RACE_TICK_MS + 700));
  }

  await raceRoom.send({
    embeds: [buildRaceStatusEmbed('finished', {
      humans: state.players,
      pot,
      winnerId: winner.userId,
      winnerName: HORSES[winner.horseIndex].name,
    })],
  }).catch(() => {});

  const winnerAnnouncement = winner.userId
    ? `🏆 <@${winner.userId}> remporte la course avec **${emojiForText(HORSES[winner.horseIndex].emoji)} ${HORSES[winner.horseIndex].name}** et empoche **${pot.toLocaleString('fr-FR')} kamas**. Une insolente démonstration pendant que les autres comptent leurs regrets.`
    : `🤖 L’IA remporte la course avec **${emojiForText(HORSES[winner.horseIndex].emoji)} ${HORSES[winner.horseIndex].name}** et rafle **${pot.toLocaleString('fr-FR')} kamas**. Votre mise est partie nourrir la machine, merci pour votre générosité involontaire.`;
  const winnerMsg = await channel.send({ content: winnerAnnouncement }).catch(() => null);

  if (winner.userId) {
    await createPayoutRecord(channel.client, guildId, winner, pot, state.players).catch(() => {});
  }

  raceStates.delete(guildId);
  await reopenParticipationCountdown(channel, guildId).catch(() => {});

  setTimeout(async () => {
    if (thread) await thread.delete().catch(() => {});
    if (starter) await starter.delete().catch(() => {});
    if (state.watchMessageId) {
      const watchMsg = await channel.messages.fetch(state.watchMessageId).catch(() => null);
      if (watchMsg) await watchMsg.delete().catch(() => {});
    }
    if (winnerMsg) await winnerMsg.delete().catch(() => {});
    if (launchingMsg) await launchingMsg.delete().catch(() => {});
    if (state.waitingMessageId) {
      const waitingMsg = await channel.messages.fetch(state.waitingMessageId).catch(() => null);
      if (waitingMsg) await waitingMsg.delete().catch(() => {});
    }
    await deleteRecentSystemMessages(channel).catch(() => {});
  }, THREAD_LIFETIME_MS);
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
      horseEmojis: null,
    });

    await interaction.editReply({ content: '✅ Dragodinde a été réinitialisé. Les messages créés par le setup ont été supprimés.' });
    return true;
  }

  if (interaction.commandName === 'dragodinde_refresh') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour faire reluire la baraque.' });
      return true;
    }
    await refreshGuildMessages(interaction.client, interaction.guild.id, getGuildConfig(interaction.guild.id)).catch(() => {});
    await interaction.editReply({ content: '✅ Annonce et dashboard rafraîchis. Le PMU a remis son maquillage.' });
    return true;
  }

  if (interaction.commandName === 'dragodinde_close') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour fermer le robinet à kamas.' });
      return true;
    }
    const guildId = interaction.guild.id;
    setGuildConfig(guildId, { ...getGuildConfig(guildId), entriesClosed: true });
    await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});
    await interaction.editReply({ content: '🔒 Participations fermées. Le PMU baisse le rideau pendant qu’on recompte les pertes.' });
    return true;
  }

  if (interaction.commandName === 'dragodinde_open') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour rouvrir le piège à pigeons.' });
      return true;
    }
    const guildId = interaction.guild.id;
    setGuildConfig(guildId, { ...getGuildConfig(guildId), entriesClosed: false });
    await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});
    await interaction.editReply({ content: '🔓 Participations rouvertes. Les volontaires peuvent revenir offrir leurs kamas à la piste.' });
    return true;
  }

  if (interaction.commandName === 'dragodinde_cancel_race') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour casser la table en plein pari.' });
      return true;
    }
    const guildId = interaction.guild.id;
    const state = raceStates.get(guildId);
    if (!state || state.started) {
      await interaction.editReply({ content: 'Aucune course en attente à annuler. Pour l’instant, le bazar est sous contrôle.' });
      return true;
    }
    for (const player of state.players || []) {
      if (player.debtRecordId) await markDebtCancelled(interaction.client, player.debtRecordId, interaction.user.id).catch(() => {});
    }
    if (state.waitInterval) clearInterval(state.waitInterval);
    if (state.waitTimeout) clearTimeout(state.waitTimeout);
    if (state.waitingMessageId) {
      const msg = await interaction.channel.messages.fetch(state.waitingMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    }
    raceStates.delete(guildId);
    await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});
    await interaction.editReply({ content: '🧹 Course en attente annulée. Les dettes ouvertes ont été remballées avec la dignité du paddock.' });
    return true;
  }

  if (interaction.commandName === 'dragodinde_soft_reset') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour secouer la machine à paris.' });
      return true;
    }
    const guildId = interaction.guild.id;
    raceStates.delete(guildId);
    const reopen = reopenCountdowns.get(guildId);
    if (reopen?.interval) clearInterval(reopen.interval);
    if (reopen?.timeout) clearTimeout(reopen.timeout);
    reopenCountdowns.delete(guildId);
    await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});
    await interaction.editReply({ content: '♻️ État temporaire réinitialisé. On a remis un coup de balai sous le tapis.' });
    return true;
  }

  if (interaction.commandName === 'set_emojis_dragodinde') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour utiliser cette commande.' });
      return true;
    }

    const guildId = interaction.guild.id;
    const cfg = getGuildConfig(guildId);
    const rawInputs = [
      interaction.options.getString('emoji1', true).trim(),
      interaction.options.getString('emoji2', true).trim(),
      interaction.options.getString('emoji3', true).trim(),
      interaction.options.getString('emoji4', true).trim(),
    ];
    const emojis = rawInputs.map((value) => normalizeEmoji(value)?.mention || value);

    setGuildConfig(guildId, { ...cfg, horseEmojis: emojis });
    refreshHorseEmojisFromConfig(guildId);
    await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});

    await interaction.editReply({
      content: `✅ Emojis Dragodinde mis à jour.\n1: ${emojis[0]}\n2: ${emojis[1]}\n3: ${emojis[2]}\n4: ${emojis[3]}\n\nSi tu mets un emoji custom, utilise de préférence son format complet Discord, par exemple <:DD1:123456789>.`,
    });
    return true;
  }

  if (interaction.commandName === 'dragodinde_import_emojis') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAdmin(interaction)) {
      await interaction.editReply({ content: 'Tu dois être administrateur pour importer des emojis.' });
      return true;
    }

    const guildId = interaction.guild.id;
    const cfg = getGuildConfig(guildId);
    const inputs = [
      interaction.options.getString('emoji1', true).trim(),
      interaction.options.getString('emoji2', true).trim(),
      interaction.options.getString('emoji3', true).trim(),
      interaction.options.getString('emoji4', true).trim(),
    ];

    try {
      const imported = [];
      for (let i = 0; i < inputs.length; i++) {
        imported.push(await importGuildEmoji(interaction.guild, inputs[i], `dragodinde_${i + 1}`));
      }

      setGuildConfig(guildId, { ...cfg, horseEmojis: imported });
      refreshHorseEmojisFromConfig(guildId);
      await refreshGuildMessages(interaction.client, guildId, getGuildConfig(guildId)).catch(() => {});

      await interaction.editReply({
        content: `✅ Emojis importés dans le serveur et assignés aux dragodindes.\n1: ${imported[0]}\n2: ${imported[1]}\n3: ${imported[2]}\n4: ${imported[3]}`,
      });
    } catch (error) {
      await interaction.editReply({ content: `Impossible d'importer les emojis: ${error.message}` });
    }
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

  if (interaction.customId === 'dragodinde:notify:toggle') {
    const cfg = getGuildConfig(interaction.guild.id);
    const roleId = cfg.notificationRoleId || cfg.allowedRoleIds?.[0] || '1480657602382790903';
    const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

    if (!role || !member) {
      await interaction.reply({ content: 'Impossible de gérer les notifications pour le moment.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const hasRole = member.roles.cache.has(role.id);
    try {
      if (hasRole) {
        await member.roles.remove(role.id);
        await interaction.reply({ content: `🔕 Notifications désactivées, rôle retiré : **${role.name}**`, flags: MessageFlags.Ephemeral });
      } else {
        await member.roles.add(role.id);
        await interaction.reply({ content: `🔔 Notifications activées, rôle ajouté : **${role.name}**`, flags: MessageFlags.Ephemeral });
      }
    } catch {
      await interaction.reply({ content: 'Je n’ai pas réussi à modifier ton rôle de notification.', flags: MessageFlags.Ephemeral });
    }
    return true;
  }

  if (interaction.customId === 'dragodinde:join:main') {
    const cfg = getGuildConfig(interaction.guild.id);
    const state = raceStates.get(interaction.guild.id);
    if (cfg.entriesClosed) {
      await interaction.reply({ content: 'Les participations sont fermées. Le PMU est en pause, probablement le temps de ramasser les kamas et les ego froissés.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (state?.started) {
      await interaction.reply({ content: 'Une course est déjà en cours. Attends la fin avant de rejoindre la suivante.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (reopenCountdowns.has(interaction.guild.id)) {
      await interaction.reply({ content: 'Les inscriptions vont rouvrir dans quelques secondes. Patiente un instant.', flags: MessageFlags.Ephemeral });
      return true;
    }

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
      content: 'Choisis maintenant ton pari contre l’IA.',
      components: iaBetRows(userId),
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

  if (interaction.customId.startsWith('dragodinde:iabet:')) {
    const [, , countRaw, userId] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const iaCount = Math.max(1, Math.min(3, Number(countRaw)));
    const session = userSessions.get(userId) || {};
    session.iaCount = iaCount;
    session.formulaLabel = iaCount === 1 ? 'Double ta mise' : iaCount === 2 ? 'Triple ta mise' : 'Jackpot 2M';
    session.iaPrize = iaCount === 1 ? 100_000 : iaCount === 2 ? 300_000 : 2_000_000;
    session.iaEntryFee = iaCount === 1 ? 55_000 : iaCount === 2 ? 105_000 : 220_000;
    session.jackpotBias = iaCount === 3;
    userSessions.set(userId, session);
    await interaction.update({
      content: `Pari IA sélectionné : **${session.formulaLabel}**. Choisis maintenant ta Dragodinde.`,
      components: horseChoiceRows(userId, 'ia'),
    });
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:horse:')) {
    const [, , mode, userId, horseIndexRaw] = interaction.customId.split(':');
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
      const session = userSessions.get(userId) || {};
      const entryFee = Number(session.iaEntryFee || ENTRY_FEE);
      const formulaLabel = session.formulaLabel || 'Double ta mise';
      session.pendingHorseIndex = horseIndex;
      userSessions.set(userId, session);

      await interaction.update({
        content: `Tu as choisi **${emojiForText(horse.emoji)} ${horse.name}** pour **${formulaLabel}**.\nConfirme ta participation pour **${entryFee.toLocaleString('fr-FR')} kamas** avant de lancer la course.`,
        components: iaConfirmRows(userId, horseIndex),
      });
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
        content: `✅ Tu rejoins la course en attente avec **${emojiForText(horse.emoji)} ${horse.name}**.`,
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
      content: `✅ Tu es inscrit avec **${emojiForText(horse.emoji)} ${horse.name}**.\nLa recherche de joueurs commence...`,
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

  if (interaction.customId.startsWith('dragodinde:iaconfirm:')) {
    const [, , action, userId, horseIndexRaw] = interaction.customId.split(':');
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: 'Ce bouton est réservé au joueur concerné.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === 'no') {
      await interaction.update({ content: 'Participation IA annulée.', components: [] });
      return true;
    }

    const guildId = interaction.guild.id;
    const session = userSessions.get(userId) || {};
    const horseIndex = Number(horseIndexRaw ?? session.pendingHorseIndex ?? 0);
    const horse = HORSES[horseIndex];
    const entryFee = Number(session.iaEntryFee || ENTRY_FEE);
    const formulaLabel = session.formulaLabel || 'Double ta mise';
    const debtRecordId = await createDebtRecord(interaction.client, guildId, interaction.user.id, horseIndex, entryFee, { mode: 'ia', formulaLabel });
    if (!debtRecordId) {
      await interaction.reply({ content: 'Impossible de créer l’engagement de paiement. Vérifie le salon logs.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.update({
      content: `✅ Participation confirmée avec **${emojiForText(horse.emoji)} ${horse.name}** pour **${formulaLabel}**. La course démarre...`,
      components: [],
    });
    raceStates.set(guildId, {
      creatorId: interaction.user.id,
      players: [{ userId: interaction.user.id, horseIndex, ai: false, joinedAt: Date.now(), debtRecordId }],
      expectedHumans: 1 + Number(session.iaCount || 1),
      iaPrize: Number(session.iaPrize || (REAL_BET * 2)),
      started: false,
    });
    await runSimpleRace(interaction.channel, guildId);
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
    await refreshGuildMessages(interaction.client, interaction.guild.id, getGuildConfig(interaction.guild.id)).catch(() => {});
    return true;
  }

  if (interaction.customId.startsWith('dragodinde:debtpaid:')) {
    const [, , recordId] = interaction.customId.split(':');
    const db = loadDebtRecords();
    const record = db[recordId];
    if (!record) {
      await interaction.reply({ content: 'Dette introuvable.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const adminRoleId = getAdminRoleId(interaction.guild.id);
    const allowed = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator) || (adminRoleId && interaction.member?.roles?.cache?.has(adminRoleId));
    if (!allowed) {
      await interaction.reply({ content: 'Rôle admin requis.', flags: MessageFlags.Ephemeral });
      return true;
    }

    if (record.status === 'paid') {
      await interaction.reply({ content: 'Cette dette est déjà marquée comme payée.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (record.status === 'cancelled') {
      await interaction.reply({ content: 'Cette dette a déjà été annulée.', flags: MessageFlags.Ephemeral });
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
        .setDescription((existingEmbed.description || '').replace('En attente de paiement', 'Dette réglée'))
        .setFooter({ text: `Dette réglée par ${interaction.user.displayName}` });
      await interaction.update({ embeds: [embed], components: [] });
    } else {
      await interaction.update({ components: [] });
    }
    await refreshGuildMessages(interaction.client, interaction.guild.id, getGuildConfig(interaction.guild.id)).catch(() => {});
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
    validateUserPayout(record.userId, record.totalAmount);

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
    await refreshGuildMessages(interaction.client, interaction.guild.id, getGuildConfig(interaction.guild.id)).catch(() => {});
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
