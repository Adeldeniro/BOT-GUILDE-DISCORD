const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  PermissionsBitField,
} = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', 'data', 'dragodinde');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEBTS_FILE = path.join(DATA_DIR, 'debts.json');
const FINANCE_FILE = path.join(DATA_DIR, 'finance.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const IMAGE_FILE = path.join(DATA_DIR, 'dragodinde.png');
const SOURCE_DIR = path.join(process.env.USERPROFILE || '', 'Desktop', 'BOT TEST JEUX');
const SOURCE_IMAGE_FILE = path.join(SOURCE_DIR, 'dragodinde.png');

const ENTRY_FEE = 55_000;
const REAL_BET = 50_000;
const COMMISSION = ENTRY_FEE - REAL_BET;
const MAX_PLAYERS = 4;
const WAIT_TIME = 180;
const FULL_LOBBY_START_DELAY_SECONDS = 25;
const MATCH_CANCEL_WINDOW_SECONDS = 20;
const JOIN_LOCK_LAST_SECONDS = 30;
const COOLDOWN_AFTER_RACE = 30;
const THREAD_LIFETIME = 45;
const DEBT_LIMIT = 1_000_000;
const PENDING_RESERVATION_SECONDS = 60;
const IA_CANCEL_WINDOW_SECONDS = 20;
const IA_PRESTART_SECONDS = 30;
const TRACK_LENGTH = 12;
const RACE_STEP_MIN = 2;
const RACE_STEP_MAX = 4;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultConfig() {
  return {
    logs_channel_id: null,
    dashboard_channel_id: null,
    dashboard_message_id: null,
    admin_role_id: null,
    notification_role_id: null,
    main_channel_id: null,
    main_message_id: null,
    allowed_role_ids: [],
    horse_emojis: ['🐎', '⚡', '🌩️', '🌊'],
  };
}

function defaultStats() {
  return {
    total_gains: 0,
    total_bets: 0,
    total_races: 0,
    ai_wins: 0,
    top_winners: {},
    last_race: {
      winner_id: null,
      winner_name: '',
      gains: 0,
      participants: [],
      timestamp: '',
    },
  };
}

function defaultRuntime() {
  return {
    raceInProgress: false,
    waitingForPlayers: false,
    cooldown: false,
    cooldownEndTime: 0,
    expectedHumans: 0,
    currentPlayers: [],
    playerHorses: {},
    playerMode: {},
    currentMatchCreatorId: null,
    currentMatchSessionId: null,
    matchmakingStartedAt: 0,
    fullLobbyDeadlineAt: 0,
    reservation: null,
    iaPendingLaunch: false,
    iaPendingUserId: null,
    iaPendingCount: 0,
    raceAnnouncementChannelId: null,
    raceAnnouncementMessageId: null,
    raceWatchChannelId: null,
    raceWatchMessageId: null,
  };
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getState() {
  ensureDataDir();
  return {
    config: loadJson(CONFIG_FILE, defaultConfig()),
    stats: loadJson(STATS_FILE, defaultStats()),
    finance: loadJson(FINANCE_FILE, {}),
    debts: loadJson(DEBTS_FILE, {}),
    runtime: loadJson(RUNTIME_FILE, defaultRuntime()),
  };
}

function saveState(state) {
  saveJson(CONFIG_FILE, state.config);
  saveJson(STATS_FILE, state.stats);
  saveJson(FINANCE_FILE, state.finance);
  saveJson(DEBTS_FILE, state.debts);
  saveJson(RUNTIME_FILE, state.runtime);
}

function horsesFromConfig(config) {
  const emojis = Array.isArray(config.horse_emojis) && config.horse_emojis.length >= 4
    ? config.horse_emojis
    : ['🐎', '⚡', '🌩️', '🌊'];
  return [
    { name: 'Tonnerre', emoji: emojis[0] || '🐎' },
    { name: 'Éclair', emoji: emojis[1] || '⚡' },
    { name: 'Foudre', emoji: emojis[2] || '🌩️' },
    { name: 'Tempête', emoji: emojis[3] || '🌊' },
  ];
}

function getUserFinance(state, userId) {
  const key = String(userId);
  if (!state.finance[key]) {
    state.finance[key] = {
      total_debt: 0,
      bets_count: 0,
      payments_count: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
  }
  return state.finance[key];
}

function getUserDebt(state, userId) {
  return Number(getUserFinance(state, userId).total_debt || 0);
}

function addUserDebt(state, userId, amount) {
  const data = getUserFinance(state, userId);
  data.total_debt += amount;
  data.bets_count += 1;
  data.updated_at = nowIso();
}

function applyUserPayment(state, userId, amount) {
  const data = getUserFinance(state, userId);
  data.total_debt = Math.max(0, Number(data.total_debt || 0) - amount);
  data.payments_count += 1;
  data.updated_at = nowIso();
}

function totalOutstandingDebt(state) {
  return Object.values(state.finance).reduce((sum, v) => sum + Number(v?.total_debt || 0), 0);
}

function indebtedPlayersCount(state) {
  return Object.values(state.finance).filter(v => Number(v?.total_debt || 0) > 0).length;
}

function aiWinrate(state) {
  const total = Number(state.stats.total_races || 0);
  if (!total) return '0%';
  return `${Math.round((Number(state.stats.ai_wins || 0) / total) * 100)}%`;
}

function isAdminMember(member, state) {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  if (state.config.admin_role_id && member.roles?.cache?.has(state.config.admin_role_id)) return true;
  return false;
}

function canUserPlay(state, member) {
  if (!member) return [false, 'Membre introuvable.'];
  if (Array.isArray(state.config.allowed_role_ids) && state.config.allowed_role_ids.length > 0) {
    const allowed = state.config.allowed_role_ids.some((roleId) => member.roles.cache.has(roleId));
    if (!allowed) return [false, 'Tu n’as pas le rôle autorisé pour jouer.'];
  }
  const debt = getUserDebt(state, member.id);
  if (debt > DEBT_LIMIT) {
    return [false, `Accès bloqué, dette actuelle ${debt.toLocaleString('fr-FR')} kamas.`];
  }
  return [true, null];
}

function reservationIsActive(state) {
  const r = state.runtime.reservation;
  return !!(r && Number(r.expires_at || 0) > Date.now());
}

function clearReservation(state) {
  state.runtime.reservation = null;
}

function createReservation(state, userId) {
  const token = crypto.randomUUID().replace(/-/g, '');
  state.runtime.reservation = {
    user_id: String(userId),
    token,
    expires_at: Date.now() + PENDING_RESERVATION_SECONDS * 1000,
  };
  return token;
}

function reservationOwnedBy(state, userId, token) {
  const r = state.runtime.reservation;
  if (!reservationIsActive(state)) return false;
  return r.user_id === String(userId) && r.token === token;
}

function getMatchmakingRemainingSeconds(state) {
  if (!state.runtime.waitingForPlayers || !state.runtime.matchmakingStartedAt) return 0;
  return Math.max(0, WAIT_TIME - Math.floor((Date.now() - state.runtime.matchmakingStartedAt) / 1000));
}

function isJoinWindowLocked(state) {
  const remaining = getMatchmakingRemainingSeconds(state);
  return remaining > 0 && remaining <= JOIN_LOCK_LAST_SECONDS;
}

function canCancelParticipationNow(state) {
  if (!state.runtime.waitingForPlayers || !state.runtime.matchmakingStartedAt) return false;
  const elapsed = Math.floor((Date.now() - state.runtime.matchmakingStartedAt) / 1000);
  return elapsed <= MATCH_CANCEL_WINDOW_SECONDS;
}

function canJoinButtonBeEnabled(state) {
  return !state.runtime.raceInProgress && !state.runtime.cooldown && !state.runtime.iaPendingLaunch;
}

function buildMainMessageContent(state, timer = null) {
  const rt = state.runtime;
  let content = '**🏇 ANIMATION GUILDE - Mise sur ta Dragodinde !**\n\n';
  content += 'Bienvenue dans **Mise sur ta Dragodinde !**\n\n';
  content += `💰 **Participation :** ${ENTRY_FEE.toLocaleString('fr-FR')} kamas\n`;
  content += `🧾 **Commission organisation :** ${COMMISSION.toLocaleString('fr-FR')} kamas par entrée\n`;
  content += `🏆 **Gain joueurs :** ${REAL_BET.toLocaleString('fr-FR')} kamas par joueur humain engagé\n`;
  content += `🤖 **Gain IA :** ${REAL_BET.toLocaleString('fr-FR')} kamas par IA battue\n`;
  content += `🚫 **Blocage dette :** au-delà de ${DEBT_LIMIT.toLocaleString('fr-FR')} kamas\n\n`;
  content += '**Comment jouer ?**\n';
  content += '• Clique sur **Participer**\n';
  content += '• Choisis le mode, puis le nombre d’adversaires, puis ta dragodinde\n';
  content += '• En mode joueurs, les places manquantes sont complétées par l’IA à la fin du délai\n\n';

  if (reservationIsActive(state) && !rt.waitingForPlayers && !rt.raceInProgress && !rt.cooldown) {
    const remaining = Math.max(0, Math.floor((rt.reservation.expires_at - Date.now()) / 1000));
    content += `⏳ **Réservation en cours** pour <@${rt.reservation.user_id}> pendant encore **${remaining} sec**\n\n`;
  }

  if (rt.iaPendingLaunch && rt.iaPendingUserId) {
    content += `🤖 **Départ contre l'IA en préparation** pour <@${rt.iaPendingUserId}>\n`;
    content += `🎯 IA prévues : **${rt.iaPendingCount}**\n`;
    content += `❌ Annulation possible pendant **${IA_CANCEL_WINDOW_SECONDS} secondes**\n`;
    content += `🚀 Départ automatique au bout de **${IA_PRESTART_SECONDS} secondes**\n\n`;
  }

  if (timer !== null && timer > 0) {
    content += `⏱️ **Prochaine course disponible dans : ${timer} secondes**\n\n`;
  } else if (rt.cooldown) {
    const remaining = Math.max(0, Math.floor((rt.cooldownEndTime - Date.now()) / 1000));
    content += `⏱️ **Prochaine course disponible dans : ${remaining} secondes**\n\n`;
  }

  if (rt.waitingForPlayers) {
    content += `👥 **Recherche d'adversaires en cours** : ${rt.currentPlayers.length}/${rt.expectedHumans}\n`;
    content += `⏱️ **Départ dans :** ${getMatchmakingRemainingSeconds(state)} sec\n`;
    content += `🔒 **Inscriptions :** ${isJoinWindowLocked(state) ? 'fermées' : 'ouvertes'}\n`;
    content += `↩️ **Annulation possible :** ${canCancelParticipationNow(state) ? 'oui' : 'non'}\n\n`;
  }

  content += '**Participants actuels :**\n';
  if (rt.currentPlayers.length) {
    const horses = horsesFromConfig(state.config);
    for (const uid of rt.currentPlayers) {
      const horseIndex = rt.playerHorses[uid];
      const horse = horseIndex !== undefined ? horses[horseIndex] : null;
      content += `• <@${uid}> ${horse ? `${horse.emoji} ${horse.name}` : '❓'}\n`;
    }
  } else {
    content += 'Aucun participant pour l’instant.\n';
  }

  content += `\n*Capacité max : ${MAX_PLAYERS} joueurs humains*`;
  return content;
}

function joinButtonRow(state) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dragodinde:join:main')
        .setLabel('Participer')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!canJoinButtonBeEnabled(state))
    ),
  ];
}

function modeChoiceRows(userId, token) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dragodinde:mode:ia:${userId}:${token}`).setLabel("Contre l'IA").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`dragodinde:mode:players:${userId}:${token}`).setLabel("Contre d'autres joueurs").setStyle(ButtonStyle.Success),
    ),
  ];
}

function countChoiceRows(userId, token, selectedMode) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dragodinde:count:${selectedMode}:1:${userId}:${token}`).setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`dragodinde:count:${selectedMode}:2:${userId}:${token}`).setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`dragodinde:count:${selectedMode}:3:${userId}:${token}`).setLabel('3').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function horseChoiceRows(state, userId, contextMode, selectedMode, selectedCount, token) {
  const horses = horsesFromConfig(state.config);
  return [
    new ActionRowBuilder().addComponents(
      horses.map((horse, index) => (
        new ButtonBuilder()
          .setCustomId(`dragodinde:horse:${contextMode}:${selectedMode}:${selectedCount ?? 'null'}:${index}:${userId}:${token || 'none'}`)
          .setLabel(horse.name)
          .setEmoji(horse.emoji)
          .setStyle(ButtonStyle.Primary)
      ))
    ),
  ];
}

function cancelParticipationRows(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dragodinde:cancel:${userId}`).setLabel('Annuler ma participation').setStyle(ButtonStyle.Danger)
    ),
  ];
}

function cancelIaLaunchRows(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dragodinde:cancelia:${userId}`).setLabel('Annuler cette course IA').setStyle(ButtonStyle.Danger)
    ),
  ];
}

function channelSelectRow(customId, placeholder) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

function roleSelectRow(customId, placeholder, options, maxValues = 1) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(maxValues)
      .addOptions(options.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value)))
  );
}

function configRows(guild) {
  const textChannels = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .first(25)
    .map((ch) => ({ label: ch.name.slice(0, 100), value: ch.id }));

  const roles = guild.roles.cache
    .filter((role) => role.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .first(25)
    .map((role) => ({ label: role.name.slice(0, 100), value: role.id }));

  return [
    roleSelectRow('dragodinde:config:logs_channel', 'Salon des logs', textChannels),
    roleSelectRow('dragodinde:config:dashboard_channel', 'Salon du dashboard', textChannels),
    roleSelectRow('dragodinde:config:admin_role', 'Rôle admin', roles),
    roleSelectRow('dragodinde:config:notif_role', 'Rôle notification', roles),
    roleSelectRow('dragodinde:config:allowed_roles', 'Rôles autorisés à jouer', roles, Math.min(roles.length || 1, 5)),
  ];
}

async function safeFetchMessage(channel, messageId) {
  try {
    return await channel.messages.fetch(messageId);
  } catch {
    return null;
  }
}

async function fetchChannel(client, channelId) {
  if (!channelId) return null;
  return client.channels.fetch(channelId).catch(() => null);
}

async function ensureImage() {
  ensureDataDir();
  if (fs.existsSync(IMAGE_FILE)) return IMAGE_FILE;
  if (fs.existsSync(SOURCE_IMAGE_FILE)) {
    fs.copyFileSync(SOURCE_IMAGE_FILE, IMAGE_FILE);
    return IMAGE_FILE;
  }
  return null;
}

async function updateMainMessageByChannel(channel, state, timer = null) {
  if (!channel || !channel.isTextBased()) return null;
  let msg = null;
  if (state.config.main_channel_id === channel.id && state.config.main_message_id) {
    msg = await safeFetchMessage(channel, state.config.main_message_id);
  }

  const payload = {
    content: buildMainMessageContent(state, timer),
    components: joinButtonRow(state),
  };
  const imagePath = await ensureImage();
  if (imagePath && !msg) payload.files = [new AttachmentBuilder(imagePath)];

  if (msg) {
    await msg.edit(payload).catch(() => {});
    return msg;
  }

  msg = await channel.send(payload);
  state.config.main_channel_id = channel.id;
  state.config.main_message_id = msg.id;
  saveState(state);
  try { await msg.pin(); } catch {}
  return msg;
}

async function updateMainMessage(client, state, timer = null) {
  const channel = await fetchChannel(client, state.config.main_channel_id);
  if (!channel) return null;
  return updateMainMessageByChannel(channel, state, timer);
}

function humanHorseLines(state, userIds, horsesSnapshot = null) {
  const horses = horsesFromConfig(state.config);
  return userIds.map((uid) => {
    const horseIndex = horsesSnapshot ? horsesSnapshot[uid] : state.runtime.playerHorses[uid];
    const horse = horseIndex !== undefined ? horses[horseIndex] : null;
    return `${horse ? horse.emoji : '❓'} <@${uid}>${horse ? ` avec **${horse.name}**` : ''}`;
  }).join('\n') || '—';
}

function buildRaceStatusEmbed(state, phase, { creatorId = null, humans = [], aiCount = 0, pot = 0, winnerId = null, winnerName = null, horsesSnapshot = null, reason = null } = {}) {
  const colorMap = {
    waiting: 0xF1C40F,
    launching: 0x3498DB,
    running: 0x9B59B6,
    finished: 0x2ECC71,
    cancelled: 0xE74C3C,
  };

  const embed = new EmbedBuilder()
    .setTitle('Course Dragodinde')
    .setColor(colorMap[phase] ?? 0x3498DB)
    .setTimestamp();

  if (phase === 'waiting') {
    const remaining = getMatchmakingRemainingSeconds(state);
    embed
      .setDescription(`**<@${creatorId}>** cherche des adversaires.\nInscrits : **${humans.length}/${state.runtime.expectedHumans}**\nPlaces restantes : **${Math.max(0, state.runtime.expectedHumans - humans.length)}**`)
      .addFields(
        { name: 'Joueurs engagés', value: humanHorseLines(state, humans, horsesSnapshot), inline: false },
        { name: 'Cagnotte actuelle', value: `${(REAL_BET * humans.length).toLocaleString('fr-FR')} kamas`, inline: false },
        { name: 'Départ dans', value: `${remaining} sec`, inline: true },
        { name: 'Inscriptions', value: isJoinWindowLocked(state) ? 'Fermées' : 'Ouvertes', inline: true },
        { name: 'Désistement', value: canCancelParticipationNow(state) ? 'Autorisé' : 'Verrouillé', inline: true },
      );
  }

  if (phase === 'launching') {
    embed.setDescription(`La course se prépare avec **${humans.length}** joueur(s) et **${aiCount}** IA.\nCagnotte : **${pot.toLocaleString('fr-FR')} kamas**`)
      .addFields({ name: 'Participants', value: humanHorseLines(state, humans, horsesSnapshot), inline: false });
  }

  if (phase === 'running') {
    embed.setDescription(`La course est en cours. Cagnotte : **${pot.toLocaleString('fr-FR')} kamas**`)
      .addFields({ name: 'Participants', value: humanHorseLines(state, humans, horsesSnapshot), inline: false });
  }

  if (phase === 'finished') {
    embed.setDescription(`Vainqueur : ${winnerId ? `<@${winnerId}>` : '**IA**'} avec **${winnerName || 'Inconnu'}**`)
      .addFields(
        { name: 'Participants', value: humanHorseLines(state, humans, horsesSnapshot), inline: false },
        { name: 'Cagnotte finale', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: true },
      );
  }

  if (phase === 'cancelled') {
    embed.setDescription(reason || 'Course annulée.');
  }

  return embed;
}

async function upsertRaceAnnouncement(client, state, channel, embed) {
  let msg = null;
  if (state.runtime.raceAnnouncementChannelId && state.runtime.raceAnnouncementMessageId) {
    const prevChannel = await fetchChannel(client, state.runtime.raceAnnouncementChannelId);
    if (prevChannel) msg = await safeFetchMessage(prevChannel, state.runtime.raceAnnouncementMessageId);
  }

  if (msg) {
    await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
    return msg;
  }

  msg = await channel.send({ embeds: [embed] });
  state.runtime.raceAnnouncementChannelId = channel.id;
  state.runtime.raceAnnouncementMessageId = msg.id;
  saveState(state);
  return msg;
}

async function clearRaceAnnouncement(client, state) {
  if (!state.runtime.raceAnnouncementChannelId || !state.runtime.raceAnnouncementMessageId) return;
  const ch = await fetchChannel(client, state.runtime.raceAnnouncementChannelId);
  if (!ch) return;
  const msg = await safeFetchMessage(ch, state.runtime.raceAnnouncementMessageId);
  if (msg) await msg.delete().catch(() => {});
  state.runtime.raceAnnouncementChannelId = null;
  state.runtime.raceAnnouncementMessageId = null;
  saveState(state);
}

function buildDashboardEmbed(state) {
  const debtRows = Object.entries(state.finance)
    .map(([uid, data]) => [uid, Number(data?.total_debt || 0)])
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return new EmbedBuilder()
    .setTitle('Dashboard Dragodinde')
    .setColor(0xF39C12)
    .addFields(
      { name: 'Dette totale', value: `${totalOutstandingDebt(state).toLocaleString('fr-FR')} kamas`, inline: true },
      { name: 'Joueurs endettés', value: String(indebtedPlayersCount(state)), inline: true },
      { name: 'Courses', value: String(state.stats.total_races || 0), inline: true },
      { name: 'Victoires IA', value: String(state.stats.ai_wins || 0), inline: true },
      { name: 'Taux IA', value: aiWinrate(state), inline: true },
      { name: 'Top dettes', value: debtRows.length ? debtRows.map(([uid, amount]) => `<@${uid}> : ${amount.toLocaleString('fr-FR')} kamas`).join('\n') : 'Aucune', inline: false },
    )
    .setTimestamp();
}

async function ensureDashboardMessage(channel, state) {
  if (!channel || !channel.isTextBased()) return null;
  let msg = null;
  if (state.config.dashboard_channel_id === channel.id && state.config.dashboard_message_id) {
    msg = await safeFetchMessage(channel, state.config.dashboard_message_id);
  }
  const payload = { embeds: [buildDashboardEmbed(state)] };
  if (msg) {
    await msg.edit(payload).catch(() => {});
    return msg;
  }
  msg = await channel.send(payload);
  state.config.dashboard_channel_id = channel.id;
  state.config.dashboard_message_id = msg.id;
  saveState(state);
  return msg;
}

async function updateDashboard(client, state) {
  if (!state.config.dashboard_channel_id) return null;
  const ch = await fetchChannel(client, state.config.dashboard_channel_id);
  if (!ch) return null;
  return ensureDashboardMessage(ch, state);
}

async function createDebtRecord(interaction, state, horseIndex) {
  if (!state.config.logs_channel_id) {
    return { ok: false, reason: 'Salon de logs non configuré.' };
  }
  const logsChannel = await interaction.client.channels.fetch(state.config.logs_channel_id).catch(() => null);
  if (!logsChannel || !logsChannel.isTextBased()) {
    return { ok: false, reason: 'Salon de logs introuvable.' };
  }

  const horses = horsesFromConfig(state.config);
  const recordId = crypto.randomUUID().replace(/-/g, '');
  const futureTotal = getUserDebt(state, interaction.user.id) + ENTRY_FEE;

  const embed = new EmbedBuilder()
    .setTitle('Engagement de participation')
    .setColor(0xFFA500)
    .setDescription(
      `**Joueur :** <@${interaction.user.id}>\n` +
      `**Montant :** ${ENTRY_FEE.toLocaleString('fr-FR')} kamas\n` +
      `**Cheval :** ${horses[horseIndex]?.emoji || '🐎'} ${horses[horseIndex]?.name || 'Inconnu'}\n` +
      `**Dette totale après inscription :** ${futureTotal.toLocaleString('fr-FR')} kamas\n` +
      `**Statut :** En attente de paiement`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dragodinde:debtpay:${recordId}`).setLabel('Valider le paiement').setStyle(ButtonStyle.Success)
  );

  const msg = await logsChannel.send({ embeds: [embed], components: [row] });
  state.debts[recordId] = {
    record_id: recordId,
    user_id: String(interaction.user.id),
    amount: ENTRY_FEE,
    horse_index: horseIndex,
    status: 'unpaid',
    channel_id: logsChannel.id,
    message_id: msg.id,
    created_at: nowIso(),
  };
  addUserDebt(state, interaction.user.id, ENTRY_FEE);
  saveState(state);
  await updateDashboard(interaction.client, state).catch(() => {});
  return { ok: true, recordId };
}

async function cancelDebtRecord(client, state, recordId) {
  const record = state.debts[recordId];
  if (!record || record.status !== 'unpaid') return false;
  record.status = 'cancelled';
  record.cancelled_at = nowIso();
  applyUserPayment(state, record.user_id, record.amount);
  saveState(state);

  const ch = await fetchChannel(client, record.channel_id);
  const msg = ch ? await safeFetchMessage(ch, record.message_id) : null;
  if (msg && msg.embeds?.[0]) {
    const embed = EmbedBuilder.from(msg.embeds[0])
      .setColor(0xE74C3C)
      .setDescription(`${msg.embeds[0].description || ''}\n\n❌ Engagement annulé`);
    await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
  }

  await updateDashboard(client, state).catch(() => {});
  return true;
}

async function cancelUserParticipationDebt(client, state, userId) {
  const entries = Object.values(state.debts).filter((rec) => rec.user_id === String(userId) && rec.status === 'unpaid');
  for (const rec of entries) {
    await cancelDebtRecord(client, state, rec.record_id);
  }
}

function generateTrack(state, positions, activeHorseIndexes) {
  const horses = horsesFromConfig(state.config);
  const lines = [];
  for (const index of activeHorseIndexes) {
    const pos = Math.min(100, positions[index]);
    const progress = Math.min(TRACK_LENGTH, Math.floor((pos / 100) * TRACK_LENGTH));
    const track = '─'.repeat(progress) + '🏁' + '─'.repeat(Math.max(0, TRACK_LENGTH - progress));
    lines.push(`${horses[index].emoji} ${horses[index].name.padEnd(9, ' ')} ${track} ${pos}%`);
  }
  return lines.join('\n');
}

function computeRaceAdvance() {
  return Math.floor(Math.random() * (RACE_STEP_MAX - RACE_STEP_MIN + 1)) + RACE_STEP_MIN;
}

async function runCountdown(thread, seconds, label = 'Départ dans') {
  const msg = await thread.send({ embeds: [new EmbedBuilder().setTitle('Pré-départ').setDescription(`${label} **${seconds}** secondes...`).setColor(0x3498DB).setTimestamp()] });
  for (let s = seconds - 1; s >= 1; s--) {
    await sleep(1000);
    await msg.edit({ embeds: [new EmbedBuilder().setTitle('Pré-départ').setDescription(`${label} **${s}** secondes...`).setColor(0x3498DB).setTimestamp()] }).catch(() => {});
  }
  await sleep(1000);
  await msg.delete().catch(() => {});
}

async function runRace(thread, state, contestants) {
  const horses = horsesFromConfig(state.config);
  const positions = [0, 0, 0, 0];
  const horseToContestant = {};
  const activeHorseIndexes = [];

  for (const [type, uid, horseIndex] of contestants) {
    horseToContestant[horseIndex] = [type, uid];
    activeHorseIndexes.push(horseIndex);
  }

  await runCountdown(thread, 5, 'La course démarre dans');
  const animMsg = await thread.send({ content: `🏇 **Départ** 🏇\n${generateTrack(state, positions, activeHorseIndexes)}` });
  await sleep(1000);

  let winnerHorse = null;
  while (winnerHorse === null) {
    const shuffled = [...activeHorseIndexes].sort(() => Math.random() - 0.5);
    for (const idx of shuffled) {
      positions[idx] += computeRaceAdvance();
      if (positions[idx] >= 100) {
        positions[idx] = 100;
        winnerHorse = idx;
        break;
      }
    }
    await animMsg.edit({ content: `🏇 **Course en cours** 🏇\n${generateTrack(state, positions, activeHorseIndexes)}` }).catch(() => {});
    await sleep(1450);
  }

  const [winnerType, winnerId] = horseToContestant[winnerHorse];
  return [winnerType, winnerId, winnerHorse, horses[winnerHorse].name];
}

async function createRaceThread(channel, prefix) {
  const starter = await channel.send({ content: '🏇' });
  const thread = await starter.startThread({ name: `${prefix}-${Math.floor(Date.now() / 1000)}`, autoArchiveDuration: 60 });
  return { starter, thread };
}

async function finishRace(client, state, channel) {
  state.runtime.waitingForPlayers = false;
  state.runtime.raceInProgress = false;
  state.runtime.expectedHumans = 0;
  state.runtime.currentMatchCreatorId = null;
  state.runtime.currentMatchSessionId = null;
  state.runtime.currentPlayers = [];
  state.runtime.playerHorses = {};
  state.runtime.playerMode = {};
  clearReservation(state);
  state.runtime.iaPendingLaunch = false;
  state.runtime.iaPendingUserId = null;
  state.runtime.iaPendingCount = 0;

  state.runtime.cooldown = true;
  state.runtime.cooldownEndTime = Date.now() + COOLDOWN_AFTER_RACE * 1000;
  saveState(state);
  await updateMainMessage(client, state).catch(() => {});

  setTimeout(async () => {
    const next = getState();
    next.runtime.cooldown = false;
    next.runtime.cooldownEndTime = 0;
    saveState(next);
    await clearRaceAnnouncement(client, next).catch(() => {});
    await updateMainMessage(client, next).catch(() => {});
  }, COOLDOWN_AFTER_RACE * 1000);
}

async function updateStatsAfterRace(state, participantsSnapshot, winnerId, winnerName, totalPool) {
  state.stats.total_races = Number(state.stats.total_races || 0) + 1;
  state.stats.total_bets = Number(state.stats.total_bets || 0) + participantsSnapshot.length;
  if (!winnerId) state.stats.ai_wins = Number(state.stats.ai_wins || 0) + 1;
  if (winnerId) {
    state.stats.total_gains = Number(state.stats.total_gains || 0) + totalPool;
    state.stats.top_winners[winnerId] = Number(state.stats.top_winners[winnerId] || 0) + totalPool;
  }
  state.stats.last_race = {
    winner_id: winnerId || null,
    winner_name: winnerName || '',
    gains: winnerId ? totalPool : 0,
    participants: participantsSnapshot,
    timestamp: nowIso(),
  };
  saveState(state);
}

async function startIaRace(interaction, state, userId, channel, nbIa) {
  if (state.runtime.raceInProgress || state.runtime.waitingForPlayers || state.runtime.iaPendingLaunch) {
    await channel.send({ content: 'Une course est déjà en cours.' }).catch(() => {});
    return;
  }

  state.runtime.iaPendingLaunch = true;
  state.runtime.iaPendingUserId = String(userId);
  state.runtime.iaPendingCount = Number(nbIa);
  saveState(state);
  await updateMainMessage(interaction.client, state).catch(() => {});

  setTimeout(async () => {
    const live = getState();
    if (!live.runtime.iaPendingLaunch || live.runtime.iaPendingUserId !== String(userId)) return;
    live.runtime.iaPendingLaunch = false;
    live.runtime.raceInProgress = true;
    saveState(live);
    await updateMainMessage(interaction.client, live).catch(() => {});

    const totalPool = REAL_BET * nbIa;
    const participantsSnapshot = [String(userId)];
    const horsesSnapshot = { ...live.runtime.playerHorses };
    const humanHorse = horsesSnapshot[String(userId)];
    const used = new Set([humanHorse]);
    const contestants = [['human', String(userId), humanHorse]];
    const available = [0, 1, 2, 3].filter((i) => !used.has(i));
    for (let i = 0; i < nbIa; i++) {
      const horse = available.length ? available.shift() : i % 4;
      contestants.push(['ai', null, horse]);
    }

    await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'launching', { humans: [String(userId)], aiCount: nbIa, pot: totalPool, horsesSnapshot }));

    let starter = null;
    let thread = null;
    try {
      const made = await createRaceThread(channel, 'course-ia');
      starter = made.starter;
      thread = made.thread;
      await thread.send({ embeds: [new EmbedBuilder().setTitle('Course contre l’IA').setDescription(`Humain : ${humanHorseLines(live, [String(userId)], horsesSnapshot)}\nIA adverses : ${nbIa}\nCagnotte : ${totalPool.toLocaleString('fr-FR')} kamas`).setColor(0x3498DB).setTimestamp()] });
      await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'running', { humans: [String(userId)], aiCount: nbIa, pot: totalPool, horsesSnapshot }));

      const [winnerType, winnerId, winnerHorseIdx, winnerName] = await runRace(thread, live, contestants);
      const horses = horsesFromConfig(live.config);

      if (winnerType === 'human') {
        await thread.send({ embeds: [new EmbedBuilder().setTitle('Victoire joueur').setDescription(`🏆 <@${winnerId}> remporte la course avec ${horses[winnerHorseIdx].emoji} **${winnerName}** et gagne **${totalPool.toLocaleString('fr-FR')} kamas**.`).setColor(0x2ECC71).setTimestamp()] });
        await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'finished', { humans: [String(userId)], aiCount: nbIa, pot: totalPool, winnerId, winnerName, horsesSnapshot }));
        await updateStatsAfterRace(live, participantsSnapshot, winnerId, winnerName, totalPool);
      } else {
        await thread.send({ embeds: [new EmbedBuilder().setTitle('Victoire IA').setDescription(`🤖 L’IA gagne avec ${horses[winnerHorseIdx].emoji} **${winnerName}**.`).setColor(0xE67E22).setTimestamp()] });
        await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'finished', { humans: [String(userId)], aiCount: nbIa, pot: 0, winnerId: null, winnerName, horsesSnapshot }));
        await updateStatsAfterRace(live, participantsSnapshot, null, winnerName, 0);
      }

      await thread.send({ content: `Ce thread sera supprimé dans ${THREAD_LIFETIME} secondes.` }).catch(() => {});
      await sleep(THREAD_LIFETIME * 1000);
    } catch {
      await channel.send({ content: 'Erreur pendant la course IA.' }).catch(() => {});
    } finally {
      if (thread) await thread.delete().catch(() => {});
      if (starter) await starter.delete().catch(() => {});
      const endState = getState();
      await finishRace(interaction.client, endState, channel);
      await updateDashboard(interaction.client, endState).catch(() => {});
    }
  }, IA_PRESTART_SECONDS * 1000);
}

async function waitForPlayers(interaction, state, channel) {
  const live = getState();
  if (!live.runtime.waitingForPlayers || live.runtime.raceInProgress) return;

  live.runtime.waitingForPlayers = false;
  live.runtime.raceInProgress = true;
  saveState(live);
  await updateMainMessage(interaction.client, live).catch(() => {});

  const humans = live.runtime.currentPlayers.slice(0, live.runtime.expectedHumans);
  const nbIaNeeded = Math.max(0, live.runtime.expectedHumans - humans.length);
  const totalPool = REAL_BET * humans.length;
  const participantsSnapshot = [...humans];
  const horsesSnapshot = { ...live.runtime.playerHorses };
  const used = new Set();
  const contestants = [];
  for (const uid of humans) {
    const horse = live.runtime.playerHorses[uid];
    contestants.push(['human', uid, horse]);
    used.add(horse);
  }
  const available = [0, 1, 2, 3].filter((i) => !used.has(i));
  for (let i = 0; i < nbIaNeeded; i++) {
    const horse = available.length ? available.shift() : i % 4;
    contestants.push(['ai', null, horse]);
  }

  await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'launching', { humans, aiCount: nbIaNeeded, pot: totalPool, horsesSnapshot }));

  let starter = null;
  let thread = null;
  try {
    const made = await createRaceThread(channel, 'course-joueurs');
    starter = made.starter;
    thread = made.thread;
    await thread.send({ embeds: [new EmbedBuilder().setTitle('Course entre joueurs').setDescription(`Participants :\n${humanHorseLines(live, humans, horsesSnapshot)}\nIA complémentaires : ${nbIaNeeded}\nCagnotte : ${totalPool.toLocaleString('fr-FR')} kamas`).setColor(0x3498DB).setTimestamp()] });
    await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'running', { humans, aiCount: nbIaNeeded, pot: totalPool, horsesSnapshot }));

    const [winnerType, winnerId, winnerHorseIdx, winnerName] = await runRace(thread, live, contestants);
    const horses = horsesFromConfig(live.config);
    if (winnerType === 'human') {
      await thread.send({ embeds: [new EmbedBuilder().setTitle('Victoire joueur').setDescription(`🏆 <@${winnerId}> gagne avec ${horses[winnerHorseIdx].emoji} **${winnerName}** et remporte **${totalPool.toLocaleString('fr-FR')} kamas**.`).setColor(0x2ECC71).setTimestamp()] });
      await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'finished', { humans, aiCount: nbIaNeeded, pot: totalPool, winnerId, winnerName, horsesSnapshot }));
      await updateStatsAfterRace(live, participantsSnapshot, winnerId, winnerName, totalPool);
    } else {
      await thread.send({ embeds: [new EmbedBuilder().setTitle('Victoire IA').setDescription(`🤖 L’IA gagne avec ${horses[winnerHorseIdx].emoji} **${winnerName}**.`).setColor(0xE67E22).setTimestamp()] });
      await upsertRaceAnnouncement(interaction.client, live, channel, buildRaceStatusEmbed(live, 'finished', { humans, aiCount: nbIaNeeded, pot: 0, winnerId: null, winnerName, horsesSnapshot }));
      await updateStatsAfterRace(live, participantsSnapshot, null, winnerName, 0);
    }

    await thread.send({ content: `Ce thread sera supprimé dans ${THREAD_LIFETIME} secondes.` }).catch(() => {});
    await sleep(THREAD_LIFETIME * 1000);
  } catch {
    await channel.send({ content: 'Erreur pendant la course joueurs.' }).catch(() => {});
  } finally {
    if (thread) await thread.delete().catch(() => {});
    if (starter) await starter.delete().catch(() => {});
    const endState = getState();
    await finishRace(interaction.client, endState, channel);
    await updateDashboard(interaction.client, endState).catch(() => {});
  }
}

async function startPlayersWait(interaction, state, userId, channel, nbAdversaires) {
  state.runtime.waitingForPlayers = true;
  state.runtime.raceInProgress = false;
  state.runtime.expectedHumans = 1 + Number(nbAdversaires);
  state.runtime.matchmakingStartedAt = Date.now();
  state.runtime.currentMatchCreatorId = String(userId);
  state.runtime.currentMatchSessionId = crypto.randomUUID().replace(/-/g, '');
  saveState(state);

  await updateMainMessage(interaction.client, state).catch(() => {});
  await upsertRaceAnnouncement(interaction.client, state, channel, buildRaceStatusEmbed(state, 'waiting', {
    creatorId: userId,
    humans: [...state.runtime.currentPlayers],
    pot: REAL_BET * state.runtime.currentPlayers.length,
    horsesSnapshot: { ...state.runtime.playerHorses },
  }));

  setTimeout(async () => {
    const live = getState();
    if (!live.runtime.waitingForPlayers) return;
    await waitForPlayers(interaction, live, channel);
  }, WAIT_TIME * 1000);
}

async function maybeApplyDraftConfig(interaction, state, draft) {
  if (!draft.logs_channel_id) return false;
  state.config.logs_channel_id = draft.logs_channel_id;
  state.config.dashboard_channel_id = draft.dashboard_channel_id || null;
  state.config.admin_role_id = draft.admin_role_id || null;
  state.config.notification_role_id = draft.notification_role_id || null;
  state.config.allowed_role_ids = draft.allowed_role_ids || [];
  saveState(state);
  await updateMainMessageByChannel(interaction.channel, state).catch(() => {});
  await updateDashboard(interaction.client, state).catch(() => {});
  return true;
}

const configDrafts = new Map();
function getConfigDraft(userId) {
  const key = String(userId);
  if (!configDrafts.has(key)) configDrafts.set(key, {});
  return configDrafts.get(key);
}

async function handleConfigSelect(interaction) {
  const state = getState();
  const draft = getConfigDraft(interaction.user.id);

  if (interaction.customId === 'dragodinde:config:logs_channel') {
    draft.logs_channel_id = interaction.values[0] || null;
    await maybeApplyDraftConfig(interaction, state, draft);
    return interaction.reply({ content: `Salon des logs sélectionné : <#${interaction.values[0]}>`, ephemeral: true });
  }
  if (interaction.customId === 'dragodinde:config:dashboard_channel') {
    draft.dashboard_channel_id = interaction.values[0] || null;
    await maybeApplyDraftConfig(interaction, state, draft);
    return interaction.reply({ content: `Salon du dashboard sélectionné : <#${interaction.values[0]}>`, ephemeral: true });
  }
  if (interaction.customId === 'dragodinde:config:admin_role') {
    draft.admin_role_id = interaction.values[0] || null;
    await maybeApplyDraftConfig(interaction, state, draft);
    return interaction.reply({ content: `Rôle admin : ${draft.admin_role_id ? `<@&${draft.admin_role_id}>` : 'Aucun'}`, ephemeral: true });
  }
  if (interaction.customId === 'dragodinde:config:notif_role') {
    draft.notification_role_id = interaction.values[0] || null;
    await maybeApplyDraftConfig(interaction, state, draft);
    return interaction.reply({ content: `Rôle notification : ${draft.notification_role_id ? `<@&${draft.notification_role_id}>` : 'Aucun'}`, ephemeral: true });
  }
  if (interaction.customId === 'dragodinde:config:allowed_roles') {
    draft.allowed_role_ids = [...interaction.values];
    await maybeApplyDraftConfig(interaction, state, draft);
    const txt = draft.allowed_role_ids.length ? draft.allowed_role_ids.map((rid) => `<@&${rid}>`).join(', ') : 'Aucun filtre';
    return interaction.reply({ content: `Rôles autorisés : ${txt}`, ephemeral: true });
  }

  return false;
}

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('dragodinde_setup').setDescription('Configure le jeu et crée l’annonce épinglée'),
    new SlashCommandBuilder().setName('config_course').setDescription('Modifier la configuration Dragodinde'),
    new SlashCommandBuilder().setName('set_emojis_dragodinde').setDescription('Définir les 4 emojis des dragodindes')
      .addStringOption((o) => o.setName('emoji1').setDescription('Tonnerre').setRequired(true))
      .addStringOption((o) => o.setName('emoji2').setDescription('Éclair').setRequired(true))
      .addStringOption((o) => o.setName('emoji3').setDescription('Foudre').setRequired(true))
      .addStringOption((o) => o.setName('emoji4').setDescription('Tempête').setRequired(true)),
    new SlashCommandBuilder().setName('setup_dashboard_dragodinde').setDescription('Crée ou met à jour le tableau de bord Dragodinde')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon du dashboard').setRequired(true).addChannelTypes(ChannelType.GuildText)),
    new SlashCommandBuilder().setName('debt_report_dragodinde').setDescription('Rapport détaillé des dettes Dragodinde'),
    new SlashCommandBuilder().setName('reset_total_dragodinde').setDescription('Supprime les messages du jeu et remet tout à zéro'),
    new SlashCommandBuilder().setName('ping_dragodinde').setDescription('Vérifier la latence du module Dragodinde'),
  ];
}

async function handleChatInputCommand(interaction) {
  const state = getState();
  const member = interaction.member;
  const guild = interaction.guild;

  if (interaction.commandName === 'dragodinde_setup') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    if (state.config.main_message_id && state.config.main_channel_id) {
      return interaction.reply({ content: 'Un message de course existe déjà. Utilise `/reset_total_dragodinde` pour repartir proprement.', ephemeral: true });
    }
    return interaction.reply({ content: 'Bienvenue dans la configuration du jeu. Choisis le salon des logs, le salon du dashboard, le rôle admin, le rôle de notification et les rôles autorisés à jouer :', components: configRows(guild), ephemeral: true });
  }

  if (interaction.commandName === 'config_course') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    return interaction.reply({ content: 'Modification de la configuration Dragodinde :', components: configRows(guild), ephemeral: true });
  }

  if (interaction.commandName === 'set_emojis_dragodinde') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    state.config.horse_emojis = [
      interaction.options.getString('emoji1', true),
      interaction.options.getString('emoji2', true),
      interaction.options.getString('emoji3', true),
      interaction.options.getString('emoji4', true),
    ];
    saveState(state);
    await interaction.reply({ content: `Emojis mis à jour : ${state.config.horse_emojis.join(' ')}`, ephemeral: true });
    await updateMainMessageByChannel(interaction.channel, state).catch(() => {});
    return true;
  }

  if (interaction.commandName === 'setup_dashboard_dragodinde') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    const salon = interaction.options.getChannel('salon', true);
    state.config.dashboard_channel_id = salon.id;
    state.config.dashboard_message_id = null;
    saveState(state);
    await ensureDashboardMessage(salon, state);
    return interaction.reply({ content: `Salon du dashboard défini sur ${salon}.`, ephemeral: true });
  }

  if (interaction.commandName === 'debt_report_dragodinde') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    const debtRows = Object.entries(state.finance)
      .filter(([, data]) => Number(data?.total_debt || 0) > 0)
      .map(([uid, data]) => [uid, Number(data.total_debt || 0), Number(data.bets_count || 0), Number(data.payments_count || 0)])
      .sort((a, b) => b[1] - a[1]);
    if (!debtRows.length) return interaction.reply({ content: 'Aucune dette en cours.', ephemeral: true });
    const lines = debtRows.slice(0, 25).map(([uid, debt, betsCount, paymentsCount]) => `${debt > DEBT_LIMIT ? 'bloqué' : 'autorisé'} <@${uid}>  **${debt.toLocaleString('fr-FR')} kamas** | paris: ${betsCount} | paiements: ${paymentsCount}`);
    const embed = new EmbedBuilder().setTitle('Rapport des dettes').setDescription(lines.join('\n')).setColor(0xE67E22).setTimestamp().addFields(
      { name: 'Dette totale', value: `${totalOutstandingDebt(state).toLocaleString('fr-FR')} kamas`, inline: true },
      { name: 'Joueurs endettés', value: String(indebtedPlayersCount(state)), inline: true },
    );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'reset_total_dragodinde') {
    if (!isAdminMember(member, state)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', ephemeral: true });
    state.config = defaultConfig();
    state.stats = defaultStats();
    state.finance = {};
    state.debts = {};
    state.runtime = defaultRuntime();
    saveState(state);
    await clearRaceAnnouncement(interaction.client, state).catch(() => {});
    return interaction.reply({ content: 'Reset total Dragodinde terminé. Relance `/dragodinde_setup` pour repartir proprement.', ephemeral: true });
  }

  if (interaction.commandName === 'ping_dragodinde') {
    return interaction.reply({ content: `Pong Dragodinde, latence: ${Math.round(interaction.client.ws.ping)} ms`, ephemeral: true });
  }

  return false;
}

async function handleButtonInteraction(interaction) {
  const state = getState();
  const { customId } = interaction;

  if (customId === 'dragodinde:join:main') {
    const [allowed, reason] = canUserPlay(state, interaction.member);
    if (!allowed) return interaction.reply({ content: reason, ephemeral: true });
    if (state.runtime.cooldown) return interaction.reply({ content: 'Une course vient de se terminer, patiente quelques secondes.', ephemeral: true });
    if (state.runtime.raceInProgress || state.runtime.iaPendingLaunch) return interaction.reply({ content: 'Une course est déjà en cours ou en préparation.', ephemeral: true });
    if (state.runtime.currentPlayers.includes(interaction.user.id)) return interaction.reply({ content: 'Tu es déjà inscrit pour cette course.', ephemeral: true });

    if (state.runtime.waitingForPlayers) {
      if (state.runtime.currentPlayers.length >= state.runtime.expectedHumans) return interaction.reply({ content: 'Toutes les places sont déjà prises.', ephemeral: true });
      if (isJoinWindowLocked(state)) return interaction.reply({ content: 'Les inscriptions sont fermées durant les 30 dernières secondes avant le départ.', ephemeral: true });
      return interaction.reply({ content: 'Choisis ta dragodinde pour rejoindre la course en attente :', components: horseChoiceRows(state, interaction.user.id, 'join_waiting', 'players', null, 'none'), ephemeral: true });
    }

    if (reservationIsActive(state) && state.runtime.reservation.user_id !== interaction.user.id) {
      const remaining = Math.max(0, Math.floor((state.runtime.reservation.expires_at - Date.now()) / 1000));
      return interaction.reply({ content: `Une autre personne est en train de finaliser son inscription, priorité à <@${state.runtime.reservation.user_id}> pendant encore **${remaining} sec**.`, ephemeral: true });
    }

    const token = createReservation(state, interaction.user.id);
    saveState(state);
    await updateMainMessage(interaction.client, state).catch(() => {});
    return interaction.reply({ content: 'Choisis ton mode de jeu :', components: modeChoiceRows(interaction.user.id, token), ephemeral: true });
  }

  if (customId.startsWith('dragodinde:mode:')) {
    const [, , mode, userId, token] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autorisé.', ephemeral: true });
    if (!reservationOwnedBy(state, userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', ephemeral: true });
    await interaction.update({ content: `Mode choisi : ${mode === 'ia' ? "Contre l'IA" : "Contre d'autres joueurs"}`, components: [] });
    const follow = await interaction.followUp({ content: mode === 'ia' ? 'Combien d’IA veux-tu affronter ? (1, 2 ou 3)' : 'Combien d’adversaires humains veux-tu ? (1, 2 ou 3)', components: countChoiceRows(userId, token, mode), ephemeral: true });
    return follow;
  }

  if (customId.startsWith('dragodinde:count:')) {
    const [, , selectedMode, count, userId, token] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autorisé.', ephemeral: true });
    if (!reservationOwnedBy(state, userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', ephemeral: true });
    await interaction.update({ content: `Nombre choisi : ${count}`, components: [] });
    return interaction.followUp({ content: 'Choisis maintenant ta dragodinde :', components: horseChoiceRows(state, userId, 'new_match', selectedMode, count, token), ephemeral: true });
  }

  if (customId.startsWith('dragodinde:horse:')) {
    const [, , contextMode, selectedMode, selectedCountRaw, horseIndexRaw, userId, token] = customId.split(':');
    const horseIndex = Number(horseIndexRaw);
    const selectedCount = selectedCountRaw === 'null' ? null : Number(selectedCountRaw);
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autorisé.', ephemeral: true });
    const [allowed, reason] = canUserPlay(state, interaction.member);
    if (!allowed) return interaction.reply({ content: reason, ephemeral: true });
    if (contextMode === 'new_match' && !reservationOwnedBy(state, userId, token)) {
      return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', ephemeral: true });
    }
    if (state.runtime.currentPlayers.includes(interaction.user.id)) return interaction.reply({ content: 'Tu es déjà inscrit.', ephemeral: true });

    if (contextMode === 'join_waiting') {
      const taken = new Set(state.runtime.currentPlayers.map((uid) => state.runtime.playerHorses[uid]).filter((v) => v !== undefined));
      if (taken.has(horseIndex)) return interaction.reply({ content: 'Cette dragodinde est déjà prise par un autre joueur.', ephemeral: true });
    }

    const result = await createDebtRecord(interaction, state, horseIndex);
    if (!result.ok) return interaction.reply({ content: result.reason, ephemeral: true });

    state.runtime.currentPlayers.push(userId);
    state.runtime.playerHorses[userId] = horseIndex;
    state.runtime.playerMode[userId] = { type: selectedMode, count: selectedCount, debt_record_id: result.recordId };
    saveState(state);

    await interaction.update({ content: `Dragodinde choisie : ${horsesFromConfig(state.config)[horseIndex].emoji} ${horsesFromConfig(state.config)[horseIndex].name}`, components: [] });
    await interaction.followUp({ content: `Dette actuelle : ${getUserDebt(state, userId).toLocaleString('fr-FR')} kamas`, ephemeral: true }).catch(() => {});

    if (contextMode === 'join_waiting') {
      await interaction.followUp({ content: `Tu as rejoint la course en attente. Annulation possible pendant ${MATCH_CANCEL_WINDOW_SECONDS} secondes.`, components: cancelParticipationRows(userId), ephemeral: true }).catch(() => {});
      await updateMainMessage(interaction.client, state).catch(() => {});
      await upsertRaceAnnouncement(interaction.client, state, interaction.channel, buildRaceStatusEmbed(state, 'waiting', { creatorId: state.runtime.currentMatchCreatorId, humans: [...state.runtime.currentPlayers], pot: REAL_BET * state.runtime.currentPlayers.length, horsesSnapshot: { ...state.runtime.playerHorses } })).catch(() => {});
      return true;
    }

    clearReservation(state);
    saveState(state);
    await interaction.followUp({ content: `Inscription validée !`, ephemeral: true }).catch(() => {});
    await updateMainMessage(interaction.client, state).catch(() => {});

    if (selectedMode === 'ia') {
      await interaction.followUp({ content: `Départ contre l’IA dans **${IA_PRESTART_SECONDS} secondes**.`, components: cancelIaLaunchRows(userId), ephemeral: true }).catch(() => {});
      await startIaRace(interaction, state, userId, interaction.channel, Number(selectedCount || 1));
    } else {
      await interaction.followUp({ content: `Recherche d’adversaires lancée.`, components: cancelParticipationRows(userId), ephemeral: true }).catch(() => {});
      await startPlayersWait(interaction, state, userId, interaction.channel, Number(selectedCount || 1));
    }
    return true;
  }

  if (customId.startsWith('dragodinde:cancelia:')) {
    const [, , userId] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autorisé.', ephemeral: true });
    if (!state.runtime.iaPendingLaunch || state.runtime.iaPendingUserId !== userId) return interaction.reply({ content: 'Il n’y a plus de départ IA en attente.', ephemeral: true });
    await cancelUserParticipationDebt(interaction.client, state, userId);
    state.runtime.iaPendingLaunch = false;
    state.runtime.iaPendingUserId = null;
    state.runtime.iaPendingCount = 0;
    state.runtime.currentPlayers = state.runtime.currentPlayers.filter((uid) => uid !== userId);
    delete state.runtime.playerHorses[userId];
    delete state.runtime.playerMode[userId];
    clearReservation(state);
    saveState(state);
    await interaction.update({ content: 'La course contre l’IA a été annulée avant le départ.', components: [] });
    await updateMainMessage(interaction.client, state).catch(() => {});
    return true;
  }

  if (customId.startsWith('dragodinde:cancel:')) {
    const [, , userId] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autorisé.', ephemeral: true });
    if (state.runtime.raceInProgress) return interaction.reply({ content: 'La course a déjà commencé.', ephemeral: true });
    if (!state.runtime.waitingForPlayers) return interaction.reply({ content: 'Il n’y a plus de phase d’attente.', ephemeral: true });
    if (!state.runtime.currentPlayers.includes(userId)) return interaction.reply({ content: 'Tu n’es plus inscrit à cette course.', ephemeral: true });
    if (!canCancelParticipationNow(state)) return interaction.reply({ content: `Le désistement n’est autorisé que pendant les ${MATCH_CANCEL_WINDOW_SECONDS} premières secondes.`, ephemeral: true });

    await cancelUserParticipationDebt(interaction.client, state, userId);
    state.runtime.currentPlayers = state.runtime.currentPlayers.filter((uid) => uid !== userId);
    delete state.runtime.playerHorses[userId];
    delete state.runtime.playerMode[userId];
    saveState(state);

    await interaction.update({ content: 'Ta participation a été annulée et ta dette retirée.', components: [] });
    await updateMainMessage(interaction.client, state).catch(() => {});
    await upsertRaceAnnouncement(interaction.client, state, interaction.channel, buildRaceStatusEmbed(state, 'waiting', { creatorId: state.runtime.currentMatchCreatorId, humans: [...state.runtime.currentPlayers], pot: REAL_BET * state.runtime.currentPlayers.length, horsesSnapshot: { ...state.runtime.playerHorses } })).catch(() => {});
    return true;
  }

  if (customId.startsWith('dragodinde:debtpay:')) {
    const [, , recordId] = customId.split(':');
    const record = state.debts[recordId];
    if (!record) return interaction.reply({ content: 'Enregistrement introuvable.', ephemeral: true });
    if (!isAdminMember(interaction.member, state)) return interaction.reply({ content: 'Rôle admin requis.', ephemeral: true });
    if (record.status === 'paid') return interaction.reply({ content: 'Ce paiement est déjà validé.', ephemeral: true });
    if (record.status === 'cancelled') return interaction.reply({ content: 'Cet engagement a déjà été annulé.', ephemeral: true });

    record.status = 'paid';
    record.paid_at = nowIso();
    record.paid_by_admin_id = interaction.user.id;
    applyUserPayment(state, record.user_id, record.amount);
    saveState(state);

    const existingEmbed = interaction.message.embeds?.[0];
    const embed = existingEmbed ? EmbedBuilder.from(existingEmbed).setColor(0x00FF00).setDescription(`${existingEmbed.description || ''}\n\n✅ Payé`) : null;
    await interaction.update({ embeds: embed ? [embed] : [], components: [] });
    await updateDashboard(interaction.client, state).catch(() => {});
    return true;
  }

  return false;
}

module.exports = {
  buildCommands,
  handleChatInputCommand,
  handleButtonInteraction,
  handleConfigSelect,
  updateMainMessage,
  ensureDashboardMessage,
};
