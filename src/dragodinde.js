const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const db = require('./db');

const CLEAN_EMOJIS = ['🐎', '⚡', '🌩️', '🌊'];
const CLEAN_NAMES = ['Tonnerre', 'Éclair', 'Foudre', 'Tempête'];

const DEFAULTS = {
  entry_fee: 55000,
  real_bet: 50000,
  debt_limit: 1000000,
  wait_time_seconds: 180,
  cooldown_after_race_seconds: 30,
  horse_emojis_json: JSON.stringify(CLEAN_EMOJIS),
  allowed_role_ids_json: JSON.stringify([]),
};

const runtimeStates = new Map();
const HORSE_NAMES = CLEAN_NAMES;

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function ensureConfigRow(guildId) {
  db.prepare(
    `INSERT INTO dragodinde_config (
      guild_id,
      entry_fee,
      real_bet,
      debt_limit,
      wait_time_seconds,
      cooldown_after_race_seconds,
      horse_emojis_json,
      allowed_role_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO NOTHING`
  ).run(
    guildId,
    DEFAULTS.entry_fee,
    DEFAULTS.real_bet,
    DEFAULTS.debt_limit,
    DEFAULTS.wait_time_seconds,
    DEFAULTS.cooldown_after_race_seconds,
    DEFAULTS.horse_emojis_json,
    DEFAULTS.allowed_role_ids_json,
  );
}

function getDragodindeConfig(guildId) {
  ensureConfigRow(guildId);
  const row = db.prepare(`SELECT * FROM dragodinde_config WHERE guild_id=?`).get(guildId);
  return {
    ...row,
    horse_emojis: safeJson(row?.horse_emojis_json, CLEAN_EMOJIS),
    allowed_role_ids: safeJson(row?.allowed_role_ids_json, []),
  };
}

function updateDragodindeConfig(guildId, patch) {
  ensureConfigRow(guildId);
  const payload = { ...patch, updated_at: Date.now() };
  const keys = Object.keys(payload);
  if (!keys.length) return getDragodindeConfig(guildId);
  const sets = keys.map(k => `${k}=?`).join(', ');
  const values = keys.map(k => payload[k]);
  db.prepare(`UPDATE dragodinde_config SET ${sets} WHERE guild_id=?`).run(...values, guildId);
  return getDragodindeConfig(guildId);
}

function ensureStatsRow(guildId) {
  db.prepare(
    `INSERT INTO dragodinde_stats (
      guild_id, total_gains, total_bets, total_races, ai_wins,
      last_race_participants_json
    ) VALUES (?, 0, 0, 0, 0, ?)
    ON CONFLICT(guild_id) DO NOTHING`
  ).run(guildId, JSON.stringify([]));
}

function getDragodindeStats(guildId) {
  ensureStatsRow(guildId);
  const row = db.prepare(`SELECT * FROM dragodinde_stats WHERE guild_id=?`).get(guildId);
  return {
    ...row,
    last_race_participants: safeJson(row?.last_race_participants_json, []),
  };
}

function updateStatsAfterRace(guildId, { participants, winnerId, winnerName, totalPool, aiWon }) {
  const stats = getDragodindeStats(guildId);
  db.prepare(
    `UPDATE dragodinde_stats SET
      total_gains=?,
      total_bets=?,
      total_races=?,
      ai_wins=?,
      last_race_winner_id=?,
      last_race_winner_name=?,
      last_race_gains=?,
      last_race_participants_json=?,
      last_race_timestamp=?
     WHERE guild_id=?`
  ).run(
    Number(stats.total_gains || 0) + Number(totalPool || 0),
    Number(stats.total_bets || 0) + (DEFAULTS.entry_fee * Number(participants?.length || 0)),
    Number(stats.total_races || 0) + 1,
    Number(stats.ai_wins || 0) + (aiWon ? 1 : 0),
    winnerId || null,
    winnerName || null,
    Number(totalPool || 0),
    JSON.stringify(participants || []),
    Date.now(),
    guildId
  );
}

function addRaceHistory(guildId, payload) {
  db.prepare(
    `INSERT INTO dragodinde_race_history (
      guild_id, winner_id, winner_name, winner_type, pot, participants_json, horses_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    guildId,
    payload.winnerId || null,
    payload.winnerName || null,
    payload.winnerType || null,
    Number(payload.pot || 0),
    JSON.stringify(payload.participants || []),
    JSON.stringify(payload.horses || {}),
    Date.now()
  );
}

function getRuntimeState(guildId) {
  if (!runtimeStates.has(guildId)) {
    runtimeStates.set(guildId, {
      raceInProgress: false,
      waitingForPlayers: false,
      cooldownUntil: null,
      expectedHumans: null,
      currentPlayers: [],
      currentMatchCreatorId: null,
      selectedMode: null,
      selectedCount: null,
      selectedHorseIndex: null,
      playerHorses: {},
      playerModes: {},
      waitingMessageId: null,
      waitTimeoutAt: null,
    });
  }
  return runtimeStates.get(guildId);
}

function saveRuntimeState(guildId) {
  const state = getRuntimeState(guildId);
  db.prepare(
    `INSERT INTO dragodinde_runtime_state (
      guild_id,
      race_in_progress,
      waiting_for_players,
      cooldown_until,
      expected_humans,
      current_match_creator_id,
      join_message_id,
      selected_mode,
      selected_count,
      selected_horse_index,
      current_players_json,
      player_horses_json,
      player_modes_json,
      state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      race_in_progress=excluded.race_in_progress,
      waiting_for_players=excluded.waiting_for_players,
      cooldown_until=excluded.cooldown_until,
      expected_humans=excluded.expected_humans,
      current_match_creator_id=excluded.current_match_creator_id,
      join_message_id=excluded.join_message_id,
      selected_mode=excluded.selected_mode,
      selected_count=excluded.selected_count,
      selected_horse_index=excluded.selected_horse_index,
      current_players_json=excluded.current_players_json,
      player_horses_json=excluded.player_horses_json,
      player_modes_json=excluded.player_modes_json,
      state_json=excluded.state_json`
  ).run(
    guildId,
    state.raceInProgress ? 1 : 0,
    state.waitingForPlayers ? 1 : 0,
    state.cooldownUntil || null,
    state.expectedHumans || null,
    state.currentMatchCreatorId || null,
    state.waitingMessageId || null,
    state.selectedMode || null,
    state.selectedCount || null,
    state.selectedHorseIndex ?? null,
    JSON.stringify(state.currentPlayers || []),
    JSON.stringify(state.playerHorses || {}),
    JSON.stringify(state.playerModes || {}),
    JSON.stringify({ version: 2, waitTimeoutAt: state.waitTimeoutAt || null })
  );
}

function loadRuntimeState(guildId) {
  const row = db.prepare(`SELECT * FROM dragodinde_runtime_state WHERE guild_id=?`).get(guildId);
  const state = getRuntimeState(guildId);
  if (!row) return state;

  const extra = safeJson(row.state_json, {});
  state.raceInProgress = Boolean(row.race_in_progress);
  state.waitingForPlayers = Boolean(row.waiting_for_players);
  state.cooldownUntil = row.cooldown_until || null;
  state.expectedHumans = row.expected_humans || null;
  state.currentMatchCreatorId = row.current_match_creator_id || null;
  state.waitingMessageId = row.join_message_id || null;
  state.selectedMode = row.selected_mode || null;
  state.selectedCount = row.selected_count || null;
  state.selectedHorseIndex = row.selected_horse_index ?? null;
  state.currentPlayers = safeJson(row.current_players_json, []);
  state.playerHorses = safeJson(row.player_horses_json, {});
  state.playerModes = safeJson(row.player_modes_json, {});
  state.waitTimeoutAt = extra.waitTimeoutAt || null;
  return state;
}

function getHorseLabel(cfg, index) {
  const emoji = (cfg.horse_emojis || CLEAN_EMOJIS)[index] || '🐎';
  const name = HORSE_NAMES[index] || `Monture ${index + 1}`;
  return `${emoji} ${name}`;
}

function buildMainEmbed(cfg, state) {
  const horseEmojis = cfg.horse_emojis || CLEAN_EMOJIS;
  const cooldownLeft = state.cooldownUntil
    ? Math.max(0, Math.ceil((state.cooldownUntil - Date.now()) / 1000))
    : null;

  return new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle('🐎 Dragodinde, panneau principal')
    .setDescription([
      `Participation: **${Number(cfg.entry_fee || DEFAULTS.entry_fee).toLocaleString('fr-FR')} kamas**`,
      `Gain joueur: **${Number(cfg.real_bet || DEFAULTS.real_bet).toLocaleString('fr-FR')} kamas**`,
      `Blocage dette: **${Number(cfg.debt_limit || DEFAULTS.debt_limit).toLocaleString('fr-FR')} kamas**`,
      '',
      `Montures: ${horseEmojis.join(' ')}`,
      state.waitingForPlayers
        ? `Recherche d'adversaires en cours: **${state.currentPlayers.length}/${state.expectedHumans || '?'}** joueurs humains`
        : 'Aucune course en attente.',
      cooldownLeft ? `Cooldown restant: **${cooldownLeft} sec**` : 'Jeu disponible.',
      state.currentPlayers.length
        ? `Participants actuels: ${state.currentPlayers.map(uid => `<@${uid}>`).join(', ')}`
        : 'Aucun participant pour le moment.',
    ].join('\n'));
}

function buildMainComponents(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dragodinde:join')
        .setLabel('🐎 Participer')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled)
    ),
  ];
}

function buildModeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dragodinde:mode:ia').setLabel("🤖 Contre l'IA").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('dragodinde:mode:players').setLabel('👥 Contre joueurs').setStyle(ButtonStyle.Success),
    ),
  ];
}

function buildCountComponents(mode) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`dragodinde:count:${mode}:1`).setLabel('1').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`dragodinde:count:${mode}:2`).setLabel('2').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`dragodinde:count:${mode}:3`).setLabel('3').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildDebtPaymentComponents(recordId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dragodinde:debtpay:${recordId}`)
        .setLabel('✅ Valider le paiement')
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildDebtLogEmbed(cfg, record, debtTotal) {
  return new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle('💰 Engagement de participation Dragodinde')
    .setDescription([
      `Joueur: <@${record.user_id}>`,
      `Montant: **${Number(record.amount).toLocaleString('fr-FR')} kamas**`,
      `Monture: ${getHorseLabel(cfg, record.horse_index)}`,
      `Dette totale après inscription: **${Number(debtTotal).toLocaleString('fr-FR')} kamas**`,
      'Statut: ⏳ En attente de paiement',
    ].join('\n'));
}

function buildHorseComponents(cfg, state) {
  const taken = new Set(Object.values(state.playerHorses || {}).map(v => Number(v)));
  const buttons = [0, 1, 2, 3].map(index => new ButtonBuilder()
    .setCustomId(`dragodinde:horse:${index}`)
    .setLabel(getHorseLabel(cfg, index))
    .setStyle(ButtonStyle.Primary)
    .setDisabled(state.waitingForPlayers && taken.has(index))
  );

  return [new ActionRowBuilder().addComponents(buttons)];
}

function buildWaitingEmbed(cfg, state) {
  const participants = state.currentPlayers.map(uid => {
    const horseIndex = state.playerHorses[uid];
    return `• <@${uid}> avec ${getHorseLabel(cfg, horseIndex)}`;
  });

  const remaining = state.waitTimeoutAt
    ? Math.max(0, Math.ceil((state.waitTimeoutAt - Date.now()) / 1000))
    : Number(cfg.wait_time_seconds || DEFAULTS.wait_time_seconds);

  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('⏳ Course joueurs en attente')
    .setDescription([
      `Créateur: <@${state.currentMatchCreatorId}>`,
      `Inscrits: **${state.currentPlayers.length}/${state.expectedHumans || '?'}**`,
      `Temps restant avant remplissage IA: **${remaining} sec**`,
      '',
      participants.length ? participants.join('\n') : 'Aucun participant.',
    ].join('\n'));
}

function getUserFinance(guildId, userId) {
  let row = db.prepare(`SELECT * FROM dragodinde_finance WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  if (!row) {
    db.prepare(
      `INSERT INTO dragodinde_finance (guild_id, user_id, total_debt, bets_count, payments_count, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)`
    ).run(guildId, userId, Date.now(), Date.now());
    row = db.prepare(`SELECT * FROM dragodinde_finance WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  }
  return row;
}

function addDebtRecord(guildId, userId, horseIndex) {
  const recordId = `${guildId}-${userId}-${Date.now()}`;
  db.prepare(
    `INSERT INTO dragodinde_debt_records (
      record_id, guild_id, user_id, amount, horse_index, status, created_at
    ) VALUES (?, ?, ?, ?, ?, 'unpaid', ?)`
  ).run(recordId, guildId, userId, DEFAULTS.entry_fee, horseIndex, Date.now());

  const finance = getUserFinance(guildId, userId);
  db.prepare(
    `UPDATE dragodinde_finance
     SET total_debt=?, bets_count=?, updated_at=?
     WHERE guild_id=? AND user_id=?`
  ).run(
    Number(finance.total_debt || 0) + DEFAULTS.entry_fee,
    Number(finance.bets_count || 0) + 1,
    Date.now(),
    guildId,
    userId
  );

  return db.prepare(`SELECT * FROM dragodinde_debt_records WHERE record_id=?`).get(recordId);
}

function markDebtAsPaid(recordId, adminUserId) {
  const record = db.prepare(`SELECT * FROM dragodinde_debt_records WHERE record_id=?`).get(recordId);
  if (!record) return { ok: false, reason: 'Enregistrement introuvable.' };
  if (record.status === 'paid') return { ok: false, reason: 'Paiement déjà validé.' };

  db.prepare(
    `UPDATE dragodinde_debt_records
     SET status='paid', paid_at=?, paid_by_admin_id=?
     WHERE record_id=?`
  ).run(Date.now(), adminUserId, recordId);

  const finance = getUserFinance(record.guild_id, record.user_id);
  db.prepare(
    `UPDATE dragodinde_finance
     SET total_debt=?, payments_count=?, updated_at=?
     WHERE guild_id=? AND user_id=?`
  ).run(
    Math.max(0, Number(finance.total_debt || 0) - Number(record.amount || 0)),
    Number(finance.payments_count || 0) + 1,
    Date.now(),
    record.guild_id,
    record.user_id
  );

  return { ok: true, record: db.prepare(`SELECT * FROM dragodinde_debt_records WHERE record_id=?`).get(recordId) };
}

function canMemberPlay(member, cfg) {
  if (!member) return { ok: false, reason: 'Membre introuvable.' };
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return { ok: true };

  const allowedRoles = Array.isArray(cfg.allowed_role_ids) ? cfg.allowed_role_ids : [];
  if (allowedRoles.length && !member.roles.cache.some(r => allowedRoles.includes(r.id))) {
    return {
      ok: false,
      reason: `⛔ Tu n'as pas accès à ce jeu. Rôles autorisés: ${allowedRoles.map(id => `<@&${id}>`).join(', ')}`,
    };
  }

  const finance = getUserFinance(member.guild.id, member.id);
  if (finance.total_debt > Number(cfg.debt_limit || DEFAULTS.debt_limit)) {
    return {
      ok: false,
      reason: `⛔ Accès bloqué. Dette actuelle: **${Number(finance.total_debt).toLocaleString('fr-FR')} kamas**`,
    };
  }

  return { ok: true };
}

function isAdminForGame(member, cfg) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (cfg.admin_role_id && member.roles.cache.has(cfg.admin_role_id)) return true;
  return false;
}

function resetStateForNextRace(guildId, preserveCooldown = true) {
  const state = getRuntimeState(guildId);
  state.raceInProgress = false;
  state.waitingForPlayers = false;
  state.expectedHumans = null;
  state.currentMatchCreatorId = null;
  state.selectedMode = null;
  state.selectedCount = null;
  state.selectedHorseIndex = null;
  state.currentPlayers = [];
  state.playerHorses = {};
  state.playerModes = {};
  state.waitingMessageId = null;
  state.waitTimeoutAt = null;
  if (!preserveCooldown) state.cooldownUntil = null;
  saveRuntimeState(guildId);
}

function generateTrack(cfg, positions, activeHorseIndexes) {
  return activeHorseIndexes.map((horseIndex, rank) => {
    const pos = positions[horseIndex];
    const filled = Math.max(0, Math.min(20, Math.floor(pos / 5)));
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    return `**${rank + 1}.** ${getHorseLabel(cfg, horseIndex)} → ${pos}% ${bar}`;
  }).join('\n');
}

async function ensureMainPanel(guild, channel, { allowCreate = true } = {}) {
  const cfg = getDragodindeConfig(guild.id);
  const state = getRuntimeState(guild.id);
  const embed = buildMainEmbed(cfg, state);
  const components = buildMainComponents(Boolean(state.raceInProgress));

  if (cfg.main_channel_id === channel.id && cfg.main_message_id) {
    try {
      const existing = await channel.messages.fetch(cfg.main_message_id);
      await existing.edit({ embeds: [embed], components });
      return existing;
    } catch {}
  }

  if (!allowCreate) return null;

  const msg = await channel.send({ embeds: [embed], components });
  try { await msg.pin(); } catch {}

  updateDragodindeConfig(guild.id, {
    main_channel_id: channel.id,
    main_message_id: msg.id,
  });

  return msg;
}

async function postDebtLog(client, guildId, record) {
  const cfg = getDragodindeConfig(guildId);
  if (!cfg.logs_channel_id) return null;
  const channel = await client.channels.fetch(cfg.logs_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const finance = getUserFinance(guildId, record.user_id);
  const msg = await channel.send({
    embeds: [buildDebtLogEmbed(cfg, record, finance.total_debt)],
    components: buildDebtPaymentComponents(record.record_id),
  }).catch(() => null);

  if (!msg) return null;

  db.prepare(`UPDATE dragodinde_debt_records SET channel_id=?, message_id=? WHERE record_id=?`).run(channel.id, msg.id, record.record_id);
  return msg;
}

async function sendFlowStep(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true });
    return;
  }

  await interaction.reply({ ...payload, ephemeral: true, flags: MessageFlags.Ephemeral });
}

function registerCommands(commands) {
  commands.push(
    new SlashCommandBuilder()
      .setName('dragodinde_setup')
      .setDescription('Configure le module Dragodinde')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption(opt =>
        opt.setName('salon_principal').setDescription('Salon du panneau principal').addChannelTypes(0, 5).setRequired(true)
      )
      .addChannelOption(opt =>
        opt.setName('salon_logs').setDescription('Salon des logs et paiements').addChannelTypes(0, 5).setRequired(false)
      )
      .addChannelOption(opt =>
        opt.setName('salon_dashboard').setDescription('Salon du dashboard').addChannelTypes(0, 5).setRequired(false)
      )
      .addRoleOption(opt =>
        opt.setName('role_admin').setDescription('Rôle admin du jeu').setRequired(false)
      )
      .addRoleOption(opt =>
        opt.setName('role_autorise').setDescription('Rôle autorisé à jouer').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('dragodinde_config')
      .setDescription('Affiche la configuration Dragodinde')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('dragodinde_refresh')
      .setDescription('Rafraîchit le panneau principal Dragodinde')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('dragodinde_stats')
      .setDescription('Affiche les statistiques Dragodinde')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  );
}

async function handleChatInput(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Commande utilisable uniquement dans un serveur.', ephemeral: true });
    return true;
  }

  const { commandName } = interaction;
  if (!['dragodinde_setup', 'dragodinde_config', 'dragodinde_refresh', 'dragodinde_stats'].includes(commandName)) {
    return false;
  }

  const guildId = interaction.guildId;

  if (commandName === 'dragodinde_setup') {
    const mainChannel = interaction.options.getChannel('salon_principal', true);
    const logsChannel = interaction.options.getChannel('salon_logs');
    const dashboardChannel = interaction.options.getChannel('salon_dashboard');
    const adminRole = interaction.options.getRole('role_admin');
    const allowedRole = interaction.options.getRole('role_autorise');

    updateDragodindeConfig(guildId, {
      logs_channel_id: logsChannel?.id || null,
      admin_role_id: adminRole?.id || null,
      dashboard_channel_id: dashboardChannel?.id || null,
      allowed_role_ids_json: JSON.stringify(allowedRole ? [allowedRole.id] : []),
    });

    const msg = await ensureMainPanel(interaction.guild, mainChannel, { allowCreate: true });

    await interaction.reply({
      content: [
        '✅ Module Dragodinde initialisé.',
        `Panneau principal: ${mainChannel}`,
        logsChannel ? `Logs: ${logsChannel}` : 'Logs: non configuré',
        dashboardChannel ? `Dashboard: ${dashboardChannel}` : 'Dashboard: non configuré',
        adminRole ? `Rôle admin: ${adminRole}` : 'Rôle admin: non configuré',
        allowedRole ? `Rôle autorisé: ${allowedRole}` : 'Rôle autorisé: tous',
        msg ? `Message principal: ${msg.url}` : 'Message principal: non créé',
      ].join('\n'),
      ephemeral: true,
    });
    return true;
  }

  if (commandName === 'dragodinde_config') {
    const cfg = getDragodindeConfig(guildId);
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('⚙️ Config Dragodinde')
      .setDescription([
        `Salon principal: ${cfg.main_channel_id ? `<#${cfg.main_channel_id}>` : '—'}`,
        `Message principal: ${cfg.main_message_id || '—'}`,
        `Salon logs: ${cfg.logs_channel_id ? `<#${cfg.logs_channel_id}>` : '—'}`,
        `Salon dashboard: ${cfg.dashboard_channel_id ? `<#${cfg.dashboard_channel_id}>` : '—'}`,
        `Rôle admin: ${cfg.admin_role_id ? `<@&${cfg.admin_role_id}>` : '—'}`,
        `Rôles autorisés: ${cfg.allowed_role_ids?.length ? cfg.allowed_role_ids.map(id => `<@&${id}>`).join(', ') : 'Tous'}`,
        `Entrée: ${Number(cfg.entry_fee || DEFAULTS.entry_fee).toLocaleString('fr-FR')} kamas`,
        `Dette max: ${Number(cfg.debt_limit || DEFAULTS.debt_limit).toLocaleString('fr-FR')} kamas`,
      ].join('\n'));

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  if (commandName === 'dragodinde_refresh') {
    const cfg = getDragodindeConfig(guildId);
    if (!cfg.main_channel_id) {
      await interaction.reply({ content: '❌ Aucun salon principal configuré. Lance /dragodinde_setup.', ephemeral: true });
      return true;
    }

    const channel = await interaction.client.channels.fetch(cfg.main_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: '❌ Salon principal inaccessible.', ephemeral: true });
      return true;
    }

    const msg = await ensureMainPanel(interaction.guild, channel, { allowCreate: true });
    await interaction.reply({ content: `✅ Panneau Dragodinde rafraîchi.${msg ? `\n${msg.url}` : ''}`, ephemeral: true });
    return true;
  }

  if (commandName === 'dragodinde_stats') {
    const stats = getDragodindeStats(guildId);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('📊 Stats Dragodinde')
      .addFields(
        { name: 'Courses', value: String(stats.total_races || 0), inline: true },
        { name: 'Mises', value: `${Number(stats.total_bets || 0).toLocaleString('fr-FR')} kamas`, inline: true },
        { name: 'Gains', value: `${Number(stats.total_gains || 0).toLocaleString('fr-FR')} kamas`, inline: true },
        { name: 'Victoires IA', value: String(stats.ai_wins || 0), inline: true },
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return true;
  }

  return false;
}

async function updateMainPanelFromInteraction(interaction) {
  const cfg = getDragodindeConfig(interaction.guildId);
  const channelId = cfg.main_channel_id || interaction.channelId;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (channel && channel.isTextBased()) {
    await ensureMainPanel(interaction.guild, channel, { allowCreate: true });
  }
}

async function startWaitingRace(interaction, cfg, state) {
  const channel = interaction.channel;
  if (!channel?.isTextBased?.()) return;

  const waitingEmbed = buildWaitingEmbed(cfg, state);
  const msg = await channel.send({ embeds: [waitingEmbed] }).catch(() => null);
  if (msg) state.waitingMessageId = msg.id;
  state.waitTimeoutAt = Date.now() + (Number(cfg.wait_time_seconds || DEFAULTS.wait_time_seconds) * 1000);
  saveRuntimeState(interaction.guildId);
}

async function updateWaitingMessage(interactionOrClient, guildId, channelId) {
  const cfg = getDragodindeConfig(guildId);
  const state = getRuntimeState(guildId);
  if (!state.waitingMessageId) return;

  const client = interactionOrClient.client || interactionOrClient;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const msg = await channel.messages.fetch(state.waitingMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [buildWaitingEmbed(cfg, state)] }).catch(() => null);
}

async function runRaceCore({ interaction, cfg, participants, horses, aiCount = 0, mode = 'players' }) {
  const guildId = interaction.guildId;
  const totalPool = DEFAULTS.real_bet * (mode === 'ia' ? aiCount : participants.length);
  const mainChannelId = cfg.main_channel_id || interaction.channelId;
  const mainChannel = await interaction.client.channels.fetch(mainChannelId).catch(() => null);

  const state = getRuntimeState(guildId);
  state.raceInProgress = true;
  state.waitingForPlayers = false;
  state.cooldownUntil = null;
  saveRuntimeState(guildId);

  let thread = null;
  try {
    if (interaction.channel?.isThread?.()) {
      thread = interaction.channel;
    } else if (interaction.channel?.threads?.create) {
      thread = await interaction.channel.threads.create({
        name: `course-${mode}-${Date.now()}`,
        autoArchiveDuration: 60,
      });
    }
  } catch {}

  const raceChannel = thread || interaction.channel;
  const introLines = [
    `🏁 **Course ${mode === 'ia' ? "contre l'IA" : 'entre joueurs'}**`,
    ...participants.map(uid => `• <@${uid}> avec ${getHorseLabel(cfg, horses[uid])}`),
  ];
  if (aiCount) introLines.push(`• IA adverses: **${aiCount}**`);
  introLines.push(`Cagnotte: **${Number(totalPool).toLocaleString('fr-FR')} kamas**`);

  await raceChannel.send({ content: introLines.join('\n') }).catch(() => null);

  const positions = [0, 0, 0, 0];
  const activeHorseIndexes = [...new Set([
    ...participants.map(uid => Number(horses[uid])),
    ...[0, 1, 2, 3].filter(idx => !Object.values(horses).map(Number).includes(idx)).slice(0, aiCount),
  ])];

  const horseOwners = {};
  for (const uid of participants) horseOwners[horses[uid]] = { type: 'human', uid };
  for (const idx of activeHorseIndexes) {
    if (!horseOwners[idx]) horseOwners[idx] = { type: 'ai', uid: null };
  }

  const animMsg = await raceChannel.send({ content: '🏇 **Départ**\n' + generateTrack(cfg, positions, activeHorseIndexes) }).catch(() => null);

  let winnerHorseIndex = null;
  for (let turn = 0; turn < 12; turn += 1) {
    for (const idx of activeHorseIndexes) {
      let advance = Math.floor(Math.random() * 10) + 4;
      if (horseOwners[idx].type === 'ai') {
        if (Math.random() < 0.4) advance += Math.floor(Math.random() * 3) + 1;
        if (Math.random() < 0.1) advance -= 1;
      }
      positions[idx] = Math.max(0, Math.min(100, positions[idx] + advance));
      if (positions[idx] >= 100) {
        winnerHorseIndex = idx;
        break;
      }
    }

    activeHorseIndexes.sort((a, b) => positions[b] - positions[a]);
    if (animMsg) {
      await animMsg.edit({ content: '🏇 **Course en cours**\n' + generateTrack(cfg, positions, activeHorseIndexes) }).catch(() => null);
    }

    if (winnerHorseIndex !== null) break;
    await new Promise(resolve => setTimeout(resolve, 900));
  }

  if (winnerHorseIndex === null) {
    activeHorseIndexes.sort((a, b) => positions[b] - positions[a]);
    winnerHorseIndex = activeHorseIndexes[0];
  }

  const winner = horseOwners[winnerHorseIndex];
  const winnerType = winner.type;
  const winnerId = winner.uid;
  const winnerName = HORSE_NAMES[winnerHorseIndex];
  const payout = winnerType === 'human' ? totalPool : 0;

  await raceChannel.send({
    content: winnerType === 'human'
      ? `🥇 <@${winnerId}> gagne avec ${getHorseLabel(cfg, winnerHorseIndex)} et remporte **${Number(payout).toLocaleString('fr-FR')} kamas** !`
      : `🤖 L'IA gagne avec ${getHorseLabel(cfg, winnerHorseIndex)}. La cagnotte reste à l'organisation.`,
  }).catch(() => null);

  updateStatsAfterRace(guildId, {
    participants,
    winnerId,
    winnerName,
    totalPool: payout,
    aiWon: winnerType === 'ai',
  });

  addRaceHistory(guildId, {
    winnerId,
    winnerName,
    winnerType,
    pot: payout,
    participants,
    horses,
  });

  state.cooldownUntil = Date.now() + (Number(cfg.cooldown_after_race_seconds || DEFAULTS.cooldown_after_race_seconds) * 1000);
  resetStateForNextRace(guildId, true);

  if (mainChannel && mainChannel.isTextBased()) {
    await ensureMainPanel(interaction.guild, mainChannel, { allowCreate: true });
  }

  if (thread) {
    await raceChannel.send({ content: 'ℹ️ Fin de course. Thread conservé pour le moment.' }).catch(() => null);
  }
}

async function maybeLaunchPlayersRace(interaction) {
  const state = getRuntimeState(interaction.guildId);
  if (!state.waitingForPlayers) return;
  if (!state.expectedHumans || state.currentPlayers.length < state.expectedHumans) return;

  const cfg = getDragodindeConfig(interaction.guildId);
  const participants = [...state.currentPlayers];
  const horses = { ...state.playerHorses };

  await interaction.channel.send({ content: '✅ Le quota est atteint, la course joueurs démarre maintenant.' }).catch(() => null);
  await runRaceCore({ interaction, cfg, participants, horses, aiCount: 0, mode: 'players' });
}

async function handleJoin(interaction) {
  const cfg = getDragodindeConfig(interaction.guildId);
  const state = getRuntimeState(interaction.guildId);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const access = canMemberPlay(member, cfg);
  if (!access.ok) {
    await sendFlowStep(interaction, { content: access.reason });
    return true;
  }

  if (state.raceInProgress) {
    await sendFlowStep(interaction, { content: '🏁 Une course est déjà en cours.' });
    return true;
  }

  const now = Date.now();
  if (state.cooldownUntil && state.cooldownUntil > now) {
    await sendFlowStep(interaction, { content: `⏳ Cooldown actif, réessaie dans ${Math.ceil((state.cooldownUntil - now) / 1000)} sec.` });
    return true;
  }

  if (state.currentPlayers.includes(interaction.user.id)) {
    await sendFlowStep(interaction, { content: 'Tu es déjà inscrit à la course en attente.' });
    return true;
  }

  if (state.waitingForPlayers) {
    state.selectedMode = 'players';
    saveRuntimeState(interaction.guildId);
    await sendFlowStep(interaction, {
      content: 'Une course joueurs est déjà ouverte. Choisis simplement ta dragodinde pour rejoindre.',
      components: buildHorseComponents(cfg, state),
    });
    return true;
  }

  await sendFlowStep(interaction, {
    content: 'Choisis ton mode de jeu :',
    components: buildModeComponents(),
  });
  return true;
}

async function handleMode(interaction, mode) {
  const state = getRuntimeState(interaction.guildId);
  state.selectedMode = mode;
  saveRuntimeState(interaction.guildId);
  await interaction.update({
    content: mode === 'ia' ? "Choisis combien d'IA tu veux affronter." : "Choisis combien d'adversaires humains tu veux.",
    components: buildCountComponents(mode),
  });
  return true;
}

async function handleCount(interaction, mode, count) {
  const cfg = getDragodindeConfig(interaction.guildId);
  const state = getRuntimeState(interaction.guildId);
  state.selectedMode = mode;
  state.selectedCount = count;
  saveRuntimeState(interaction.guildId);
  await interaction.update({
    content: 'Choisis maintenant ta dragodinde :',
    components: buildHorseComponents(cfg, state),
  });
  return true;
}

async function handleHorse(interaction, horseIndex) {
  const cfg = getDragodindeConfig(interaction.guildId);
  const state = getRuntimeState(interaction.guildId);
  const userId = interaction.user.id;

  if (!state.selectedMode) {
    await sendFlowStep(interaction, { content: '⛔ Séquence incomplète. Recommence avec le bouton Participer.' });
    return true;
  }

  if (state.selectedMode === 'ia' && !state.selectedCount) {
    await sendFlowStep(interaction, { content: '⛔ Choisis d’abord le nombre d’IA.' });
    return true;
  }

  if (state.currentPlayers.includes(userId)) {
    await sendFlowStep(interaction, { content: 'Tu es déjà inscrit.' });
    return true;
  }

  const taken = new Set(Object.values(state.playerHorses || {}).map(v => Number(v)));
  if (state.waitingForPlayers && taken.has(horseIndex)) {
    await sendFlowStep(interaction, { content: '⛔ Cette monture est déjà prise.' });
    return true;
  }

  const record = addDebtRecord(interaction.guildId, userId, horseIndex);
  state.selectedHorseIndex = horseIndex;
  state.currentPlayers.push(userId);
  state.playerHorses[userId] = horseIndex;
  state.playerModes[userId] = {
    type: state.selectedMode,
    count: state.selectedCount,
    debt_record_id: record.record_id,
  };

  if (state.selectedMode === 'players') {
    if (!state.waitingForPlayers) {
      state.waitingForPlayers = true;
      state.expectedHumans = Number(state.selectedCount) + 1;
      state.currentMatchCreatorId = userId;
      await startWaitingRace(interaction, cfg, state);
    } else {
      saveRuntimeState(interaction.guildId);
      await updateWaitingMessage(interaction, interaction.guildId, interaction.channelId);
    }
  } else {
    saveRuntimeState(interaction.guildId);
  }

  const finance = getUserFinance(interaction.guildId, userId);
  const horseLabel = getHorseLabel(cfg, horseIndex);

  await interaction.update({
    content: [
      `✅ Inscription enregistrée avec ${horseLabel}`,
      `Mode: **${state.selectedMode === 'ia' ? 'IA' : 'Joueurs'}**`,
      `Adversaires: **${state.selectedCount || (state.expectedHumans ? state.expectedHumans - 1 : '?')}**`,
      `Dette actuelle: **${Number(finance.total_debt).toLocaleString('fr-FR')} kamas**`,
      cfg.logs_channel_id ? 'Un log de paiement a été envoyé au salon staff.' : 'Aucun salon de logs configuré pour le paiement.',
      state.selectedMode === 'players'
        ? `Course ouverte. Inscrits: **${state.currentPlayers.length}/${state.expectedHumans}** joueurs humains.`
        : 'Course IA en préparation...',
    ].join('\n'),
    components: [],
  });

  await postDebtLog(interaction.client, interaction.guildId, record);
  await updateMainPanelFromInteraction(interaction);

  if (state.selectedMode === 'ia') {
    const participants = [userId];
    const horses = { [userId]: horseIndex };
    await runRaceCore({ interaction, cfg, participants, horses, aiCount: Number(state.selectedCount || 0), mode: 'ia' });
    return true;
  }

  await maybeLaunchPlayersRace(interaction);
  return true;
}

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
    return handleChatInput(interaction);
  }

  if (interaction.isButton && interaction.isButton()) {
    if (interaction.customId === 'dragodinde:join') {
      return handleJoin(interaction);
    }

    if (interaction.customId.startsWith('dragodinde:mode:')) {
      const [, , mode] = interaction.customId.split(':');
      return handleMode(interaction, mode);
    }

    if (interaction.customId.startsWith('dragodinde:count:')) {
      const [, , mode, countRaw] = interaction.customId.split(':');
      return handleCount(interaction, mode, Number(countRaw));
    }

    if (interaction.customId.startsWith('dragodinde:horse:')) {
      const horseIndex = Number(interaction.customId.split(':')[2]);
      return handleHorse(interaction, horseIndex);
    }

    if (interaction.customId.startsWith('dragodinde:debtpay:')) {
      const recordId = interaction.customId.split(':')[2];
      const cfg = getDragodindeConfig(interaction.guildId);
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!isAdminForGame(member, cfg)) {
        await sendFlowStep(interaction, { content: '⛔ Rôle admin requis pour valider ce paiement.' });
        return true;
      }

      const result = markDebtAsPaid(recordId, interaction.user.id);
      if (!result.ok) {
        await sendFlowStep(interaction, { content: `❌ ${result.reason}` });
        return true;
      }

      const paidRecord = result.record;
      const finance = getUserFinance(interaction.guildId, paidRecord.user_id);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('✅ Paiement validé')
        .setDescription([
          `Joueur: <@${paidRecord.user_id}>`,
          `Montant validé: **${Number(paidRecord.amount).toLocaleString('fr-FR')} kamas**`,
          `Dette restante: **${Number(finance.total_debt).toLocaleString('fr-FR')} kamas**`,
          `Validé par: <@${interaction.user.id}>`,
        ].join('\n'));

      await interaction.update({ embeds: [embed], components: [] });
      return true;
    }
  }

  return false;
}

async function init(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      ensureConfigRow(guild.id);
      ensureStatsRow(guild.id);
      loadRuntimeState(guild.id);
    } catch (e) {
      console.warn('[dragodinde] init guild failed:', guild.id, e?.message || e);
    }
  }
}

module.exports = {
  registerCommands,
  handleInteraction,
  init,
  ensureConfigRow,
  ensureStatsRow,
  getDragodindeConfig,
  updateDragodindeConfig,
  getDragodindeStats,
  ensureMainPanel,
};
