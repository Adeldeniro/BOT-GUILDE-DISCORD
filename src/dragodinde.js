const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  ChannelType,
  ThreadAutoArchiveDuration,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// =========================================================
// CONFIG / FICHIERS
// =========================================================

const DATA_DIR = path.join(__dirname, '..', 'data', 'dragodinde');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEBTS_FILE = path.join(DATA_DIR, 'debts.json');
const FINANCE_FILE = path.join(DATA_DIR, 'finance.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const LOG_FILE = path.join(DATA_DIR, 'bot_errors.log');
const IMAGE_FILENAME = path.join(DATA_DIR, 'dragodinde.png');

const SOURCE_IMAGE = path.join(process.env.USERPROFILE || '', 'Desktop', 'BOT TEST JEUX', 'dragodinde.png');
if (!fs.existsSync(IMAGE_FILENAME) && fs.existsSync(SOURCE_IMAGE)) {
  fs.copyFileSync(SOURCE_IMAGE, IMAGE_FILENAME);
}

const IMAGE_URL = 'https://media.discordapp.net/attachments/1481127126248984679/1494762706899701891/980ba366-2d5c-46c4-b4a9-df92e4e90f70.png?ex=69e3c9c0&is=69e27840&hm=c6652dfdc2999cacc80d9f8df4c6ef01de1a36b28c9e8fd2d3d13b112d7014a8&=&format=webp&quality=lossless';
const RESULT_IMAGE_URL = 'https://cdn.discordapp.com/attachments/1481127126248984679/1495225714117447710/0436af6e-f2de-4962-8e0d-0451f6a9e493.png';
const RACE_BANNER_URL = 'https://cdn.discordapp.com/attachments/1481127126248984679/1495230856178962582/Gemini_Generated_Image_lxhg3glxhg3glxhg.png';

// =========================================================
// CONSTANTES JEU
// =========================================================

const ENTRY_FEE = 55_000;
const REAL_BET = 50_000;
const COMMISSION = ENTRY_FEE - REAL_BET;
const MAX_PLAYERS = 4;
const WAIT_TIME = 120;
const FULL_LOBBY_START_DELAY_SECONDS = 15;
const CANCEL_JOIN_WINDOW_SECONDS = 60;
const MATCH_CANCEL_WINDOW_SECONDS = 15;
const JOIN_LOCK_LAST_SECONDS = 20;
const COOLDOWN_AFTER_RACE = 20;
const THREAD_LIFETIME = 30;
const DEBT_LIMIT = 1_000_000;
const PENDING_RESERVATION_SECONDS = 60;

const IA_CANCEL_WINDOW_SECONDS = 15;
const IA_PRESTART_SECONDS = 20;
const JACKPOT_CONFIRM_WINDOW_SECONDS = 20;

const ROLE_NOTIFICATION_DELETE_AFTER_SECONDS = 20;

const TRACK_LENGTH = 12;

const RACE_STEP_MIN = 3;
const RACE_STEP_MAX = 5;

const COMEBACK_TRIGGER_GAP = 10;
const COMEBACK_BONUS_CHANCE = 0.35;

const LEADER_SLOWDOWN_GAP = 12;
const LEADER_SLOWDOWN_CHANCE = 0.28;

const AI_SUBTLE_BONUS_CHANCE = 0.16;
const AI_SUBTLE_MALUS_CHANCE = 0.10;

// =========================================================
// LOGS
// =========================================================

function logLine(level, message) {
  const line = `${new Date().toISOString()} | ${level} | ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + os.EOL, 'utf8');
  } catch {}
}

function logInfo(message) { logLine('INFO', message); }
function logWarn(message) { logLine('WARN', message); }
function logError(message) { logLine('ERROR', message); }

function logException(context, error) {
  logError(`[EXCEPTION] ${context}`);
  if (error?.stack) logError(error.stack);
  else if (error) logError(String(error));
}

// =========================================================
// JSON HELPERS
// =========================================================

function utcnow() {
  return new Date();
}

function nowIso() {
  return utcnow().toISOString();
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
    horse_emojis: ['­ƒÉÄ', 'ÔÜí', '­ƒî®´©Å', '­ƒîè'],
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

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logWarn(`Chargement ${path.basename(file)}: ${error.message}`);
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logError(`Sauvegarde ${path.basename(file)}: ${error.message}`);
  }
}

let config = loadJson(CONFIG_FILE, defaultConfig());
let stats = loadJson(STATS_FILE, defaultStats());
let rawDebtRecords = loadJson(DEBTS_FILE, {});
let rawFinance = loadJson(FINANCE_FILE, {});
let rawPayoutRecords = loadJson(path.join(DATA_DIR, 'payouts.json'), {});

function normalizeDebtRecords(rawData) {
  const normalized = {};
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return normalized;
  for (const [key, value] of Object.entries(rawData)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) normalized[key] = value;
  }
  return normalized;
}

function normalizeFinance(rawData) {
  const normalized = {};
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return normalized;

  for (const [key, value] of Object.entries(rawData)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    normalized[String(key)] = {
      total_debt: Math.max(0, Number(value.total_debt || 0)),
      bets_count: Math.max(0, Number(value.bets_count || 0)),
      payments_count: Math.max(0, Number(value.payments_count || 0)),
      created_at: value.created_at || nowIso(),
      updated_at: value.updated_at || nowIso(),
    };
  }
  return normalized;
}

let debtRecords = normalizeDebtRecords(rawDebtRecords);
let finance = normalizeFinance(rawFinance);
let payoutRecords = normalizeDebtRecords(rawPayoutRecords);

function saveConfig() { saveJson(CONFIG_FILE, config); }
function saveStats() { saveJson(STATS_FILE, stats); }
function saveDebtRecords() { saveJson(DEBTS_FILE, debtRecords); }
function saveFinance() { saveJson(FINANCE_FILE, finance); }
function savePayoutRecords() { saveJson(path.join(DATA_DIR, 'payouts.json'), payoutRecords); }

// =========================================================
// CONFIG EN M├ëMOIRE
// =========================================================

let LOGS_CHANNEL_ID = config.logs_channel_id;
let DASHBOARD_CHANNEL_ID = config.dashboard_channel_id;
let DASHBOARD_MESSAGE_ID = config.dashboard_message_id;
let ADMIN_ROLE_ID = config.admin_role_id;
let NOTIF_ROLE_ID = config.notification_role_id;
let MAIN_CHANNEL_ID = config.main_channel_id;
let MAIN_MESSAGE_ID = config.main_message_id;
let ALLOWED_ROLE_IDS = config.allowed_role_ids || [];
let HORSE_EMOJIS = config.horse_emojis || ['­ƒÉÄ', 'ÔÜí', '­ƒî®´©Å', '­ƒîè'];

// =========================================================
// ├ëTATS GLOBAUX
// =========================================================

let raceInProgress = false;
let waitingForPlayers = false;
let cooldown = false;
let cooldownEndTime = 0;

let currentPlayers = [];
let playerHorses = {};
let playerMode = {};
let matchmakingStartedAt = 0;
let fullLobbyDeadlineAt = 0;
let matchLaunchInProgress = false;

let expectedHumans = 0;
let currentMatchCreatorId = null;
let currentMatchSessionId = null;

let raceAnnouncementMsg = null;
let raceWatchMessage = null;
let mainMessage = null;
let timerMessage = null;

let waitTask = null;
let waitTimeoutTask = null;
let timerTask = null;
let currentReservation = null;
let reservationTask = null;

let iaPendingLaunch = false;
let iaPendingUserId = null;
let iaPendingCount = 0;
let iaPendingChannelId = null;
let iaPendingToken = null;
let iaStartTask = null;
let iaStartThreadMessage = null;
let iaCountdownMessage = null;
let iaCountdownIntervalTask = null;

let client = null;

let HORSES = [
  { name: 'Tonnerre', emoji: HORSE_EMOJIS[0] },
  { name: 'Éclair', emoji: HORSE_EMOJIS[1] },
  { name: 'Foudre', emoji: HORSE_EMOJIS[2] },
  { name: 'Tempête', emoji: HORSE_EMOJIS[3] },
];

// =========================================================
// HELPERS DISCORD
// =========================================================

async function discordRetry(fn, retries = 3, delay = 800) {
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.code;
      const retryable = [429, 500, 502, 503, 504].includes(Number(status));
      if (!retryable || i === retries - 1) throw error;
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
  throw lastError;
}

async function safeSend(channel, payload) {
  return discordRetry(() => channel.send(payload));
}

async function safeEditMessage(message, payload) {
  return discordRetry(() => message.edit(payload));
}

async function safeDeleteMessage(message) {
  try {
    await discordRetry(() => message.delete());
  } catch {}
}

async function safeFetchMessage(channelId, messageId) {
  try {
    if (!channelId || !messageId || !client) return null;
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return null;
    return await discordRetry(() => channel.messages.fetch(messageId));
  } catch {
    return null;
  }
}

async function deleteRecentSystemMessages(channel, limit = 10) {
  try {
    if (!channel || !channel.isTextBased()) return;
    const messages = await channel.messages.fetch({ limit });
    for (const msg of messages.values()) {
      if (msg.system) {
        try { await msg.delete(); } catch {}
      }
    }
  } catch {}
}

function autoDeleteInteractionReply(interaction, delayMs = 8000) {
  setTimeout(() => { interaction.deleteReply().catch(() => {}); }, delayMs);
}

function autoDeleteFollowUp(interaction, message, delayMs = 8000) {
  const msg = message?.resource?.message || message;
  if (!msg?.id) return;
  setTimeout(() => { interaction.webhook.deleteMessage(msg.id).catch(() => {}); }, delayMs);
}

// =========================================================
// UTILITAIRES
// =========================================================

function refreshHorsesFromEmojis() {
  HORSES = [
    { name: 'Tonnerre', emoji: HORSE_EMOJIS[0] },
    { name: 'Éclair', emoji: HORSE_EMOJIS[1] },
    { name: 'Foudre', emoji: HORSE_EMOJIS[2] },
    { name: 'Tempête', emoji: HORSE_EMOJIS[3] },
  ];
}

function getLogsChannel() {
  return LOGS_CHANNEL_ID && client ? client.channels.cache.get(LOGS_CHANNEL_ID) || null : null;
}

function notifRoleMention() {
  return NOTIF_ROLE_ID ? `<@&${NOTIF_ROLE_ID}>` : '';
}

function notifAllowedMentions() {
  return NOTIF_ROLE_ID ? { roles: [NOTIF_ROLE_ID] } : { parse: [] };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function formatListMentions(userIds) {
  return userIds.map((uid) => `<@${uid}>`).join(', ');
}

function getSearchRoleNotification(userId, nbAdversaires) {
  return pickRandom([
    `Les ├®curies tremblent d├®j├á, <@${userId}> cherche **${nbAdversaires} adversaire(s)** assez t├®m├®raires pour venir se faire humilier avec panache.`,
    `Un pari vient dÔÇÖ├¬tre lanc├® et <@${userId}> r├®clame **${nbAdversaires} adversaire(s)**. Qui veut signer son propre arr├¬t de style ?`,
    ` <@${userId}> ouvre la danse et cherche **${nbAdversaires} adversaire(s)**. La piste accepte tout le monde, m├¬me les futurs regrets.`,
    `Avis aux volontaires, <@${userId}> veut **${nbAdversaires} adversaire(s)**. Oui, m├¬me ceux qui confondent vitesse et bonne volont├®.`,
  ]);
}

function getIaStartRoleNotification(userId, formulaLabel, prizeAmount) {
  const prizeText = Number(prizeAmount || 0).toLocaleString('fr-FR');
  return pickRandom([
    `<@${userId}> vient de tenter la formule **${formulaLabel}** pour arracher **${prizeText} kamas** au PMU. Une confiance comme ├ºa m├®rite presque le respect. Presque.`,
    `<@${userId}> se pr├®sente avec la formule **${formulaLabel}** et r├¬ve d├®j├á de repartir avec **${prizeText} kamas**. La piste adore ce genre d'arrogance.`,
    `Coup de folie au PMU, <@${userId}> active **${formulaLabel}** pour viser **${prizeText} kamas**. Soit ├ºa brille, soit ├ºa fera une superbe humiliation publique.`,
    `<@${userId}> ose la formule **${formulaLabel}** avec **${prizeText} kamas** en ligne de mire. Les IA regardent ├ºa avec le calme insolent des gens qui savent d├®j├á courir.`,
    `<@${userId}> sort les ambitions trop grandes pour la piste et choisit **${formulaLabel}**. Objectif affich├®, **${prizeText} kamas**. Objectif r├®el, ├®viter le ridicule.`,
    `Le PMU note un exc├¿s de confiance, <@${userId}> part sur **${formulaLabel}** avec **${prizeText} kamas** en vue. Les IA, elles, appellent ├ºa une livraison.`,
    `<@${userId}> force la porte avec **${formulaLabel}** et un r├¬ve ├á **${prizeText} kamas**. Tr├¿s belle ├®nergie. Voyons si elle survit jusquÔÇÖ├á lÔÇÖarriv├®e.`,
    `On signale au comptoir que <@${userId}> a choisi **${formulaLabel}** pour tenter **${prizeText} kamas**. Une d├®cision courageuse, ou d├®corative, selon les 30 prochaines secondes.`,
  ]);
}

function getPlayersStartRoleNotification(humans) {
  const list = formatListMentions(humans);
  return pickRandom([
    `Les sabots frappent la piste, la course d├®marre entre ${list}. Il va bien falloir quÔÇÖun seul m├®rite vraiment de fanfaronner.`,
    `D├®part brutal entre ${list}. Certains viennent pour gagner, dÔÇÖautres pour servir dÔÇÖexemple.`,
    `Les portes claquent et la poussi├¿re monte, ${list} se jettent dans lÔÇÖar├¿ne. La dignit├®, elle, attend au bord de la piste.`,
    `La course commence entre ${list}. Il nÔÇÖy aura quÔÇÖun vainqueur, et plusieurs belles excuses.`,
  ]);
}

function getHumanVictoryEmbedText(winnerHorseEmoji, winnerName, winnerId, totalPool, options = {}) {
  const totalText = totalPool.toLocaleString('fr-FR');
  const refundedStake = Number(options.refundedStake || 0);
  const refundedText = refundedStake > 0 ? ` et r├®cup├¿re sa mise jou├®e de **${refundedStake.toLocaleString('fr-FR')} kamas**` : '';
  const formulaLabel = options.formulaLabel || null;

  if (formulaLabel === 'Double ta mise') {
    return pickRandom([
      {
        title: 'Le petit billet qui fait fanfaronner',
        description:
          `${winnerHorseEmoji} **${winnerName}** arrache la ligne dÔÇÖarriv├®e avec juste ce quÔÇÖil faut dÔÇÖinsolence pour agacer tout le monde.\n\n` +
          `<@${winnerId}> plie la formule **Double ta mise** et repart avec **${totalText} kamas**. Pas mal pour quelquÔÇÖun quÔÇÖon croyait venu d├®corer la piste.`
      },
      {
        title: 'Le PMU l├óche quelques billets',
        description:
          `${winnerHorseEmoji} **${winnerName}** passe devant au bon moment, avec cette ├®l├®gance aga├ºante des gens qui ont raison sans pr├®venir.\n\n` +
          `<@${winnerId}> valide **Double ta mise** et encaisse **${totalText} kamas**. Ce nÔÇÖest pas le hold-up du si├¿cle, mais cÔÇÖest d├®j├á assez pour bomber le torse.`
      },
      {
        title: 'Le pari discret fait du bruit',
        description:
          `${winnerHorseEmoji} **${winnerName}** glisse devant la meute avec lÔÇÖair insolent de quelquÔÇÖun qui savait d├®j├á comment ├ºa finirait.\n\n` +
          `<@${winnerId}> transforme **Double ta mise** en petite humiliation ├®l├®gante et repart avec **${totalText} kamas**.`
      },
      {
        title: 'Une mise modeste, un ego qui gonfle',
        description:
          `${winnerHorseEmoji} **${winnerName}** ferme le d├®bat sans trembler et laisse les IA regarder passer le panache.\n\n` +
          `<@${winnerId}> touche **${totalText} kamas** sur **Double ta mise**. Ce nÔÇÖest pas ├®norme, mais cÔÇÖest largement suffisant pour devenir insupportable au comptoir.`
      },
    ]);
  }

  if (formulaLabel === 'Triple ta mise') {
    return pickRandom([
      {
        title: 'Le PMU commence ├á grimacer',
        description:
          `${winnerHorseEmoji} **${winnerName}** envoie tout le monde respirer la poussi├¿re avec une facilit├® franchement irritante.\n\n` +
          `<@${winnerId}> fait sauter la formule **Triple ta mise** et empoche **${totalText} kamas**. L├á, on commence ├á parler dÔÇÖun vrai manque de savoir-vivre envers lÔÇÖorganisation.`
      },
      {
        title: 'Une arriv├®e qui co├╗te cher au comptoir',
        description:
          `${winnerHorseEmoji} **${winnerName}** traverse la piste comme si le r├®sultat ├®tait ├®crit depuis le d├®part.\n\n` +
          `<@${winnerId}> rafle **${totalText} kamas** avec **Triple ta mise**. ├Ç ce niveau-l├á, ce nÔÇÖest plus un pari, cÔÇÖest une gifle bien habill├®e.`
      },
      {
        title: 'Le comptoir serre un peu les dents',
        description:
          `${winnerHorseEmoji} **${winnerName}** prend la t├¬te avec une insolence qui fr├┤le lÔÇÖind├®cence.\n\n` +
          `<@${winnerId}> retourne **Triple ta mise** contre le PMU et sÔÇÖoffre **${totalText} kamas**. Il y a des victoires quÔÇÖon applaudit, et dÔÇÖautres quÔÇÖon dig├¿re mal.`
      },
      {
        title: 'Le pari nerveux passe cr├¿me',
        description:
          `${winnerHorseEmoji} **${winnerName}** tend une embuscade parfaite ├á la piste et sort au bon moment, comme dans les histoires quÔÇÖon d├®teste entendre quand ce nÔÇÖest pas nous.\n\n` +
          `<@${winnerId}> encaisse **${totalText} kamas** sur **Triple ta mise**. CÔÇÖest propre, net, et l├®g├¿rement vexant pour tout le monde.`
      },
    ]);
  }

  if (formulaLabel === 'Jackpot 2M') {
    return pickRandom([
      {
        title: 'Le casse du PMU est r├®ussi',
        description:
          `${winnerHorseEmoji} **${winnerName}** vient de faire taire toute la piste dans un fracas de sabots et dÔÇÖego froiss├®.\n\n` +
          `<@${winnerId}> arrache le **Jackpot 2M** et repart avec **${totalText} kamas**. Oui, ├ºa pique pour lÔÇÖorganisation, et cÔÇÖest bien ├ºa qui est insupportable.`
      },
      {
        title: 'Le comptoir va en parler toute la semaine',
        description:
          `${winnerHorseEmoji} **${winnerName}** signe une arriv├®e insolente, presque obsc├¿ne de facilit├®.\n\n` +
          `<@${winnerId}> fait sauter le **Jackpot 2M** et encaisse **${totalText} kamas**. ├Ç ce niveau-l├á, ce nÔÇÖest plus une victoire, cÔÇÖest une provocation.`
      },
      {
        title: 'Le braquage se fait en plein jour',
        description:
          `${winnerHorseEmoji} **${winnerName}** d├®boule sur la ligne finale comme si le PMU lui appartenait d├®j├á.\n\n` +
          `<@${winnerId}> renverse le **Jackpot 2M** et repart avec **${totalText} kamas**. Il y a des paris audacieux, et puis il y a ├ºa.`
      },
      {
        title: 'Le comptoir encaisse en silence',
        description:
          `${winnerHorseEmoji} **${winnerName}** transforme la derni├¿re ligne droite en sc├¿ne de crime parfaitement ex├®cut├®e.\n\n` +
          `<@${winnerId}> vide le **Jackpot 2M** et prend **${totalText} kamas**. M├¬me les murs du PMU vont avoir besoin dÔÇÖun moment pour sÔÇÖen remettre.`
      },
    ]);
  }

  return pickRandom([
    {
      title: 'Le verdict claque comme un fouet',
      description:
        `Dans un vacarme de sabots, ${winnerHorseEmoji} **${winnerName}** traverse la poussi├¿re et plante tout le monde sur place.\n\n` +
        `<@${winnerId}> remporte **${totalText} kamas**${refundedText}.`
    },
    {
      title: 'Une arriv├®e qui pique lÔÇÖorgueil',
      description:
        `${winnerHorseEmoji} **${winnerName}** d├®chire la derni├¿re ligne droite avec une insolence presque artistique.\n\n` +
        `<@${winnerId}> sÔÇÖimpose et gagne **${totalText} kamas**${refundedText}. Les autres peuvent toujours applaudir, cÔÇÖest gratuit.`
    },
  ]);
}

function getAiVictoryEmbedText(winnerHorseEmoji, winnerName, totalPool, options = {}) {
  const formulaLabel = options.formulaLabel || null;

  if (formulaLabel === 'Double ta mise') {
    return pickRandom([
      {
        title: 'Le PMU garde la monnaie',
        description:
          `${winnerHorseEmoji} **${winnerName}** casse le petit r├¬ve avant m├¬me quÔÇÖil prenne trop de place.\n\n` +
          `LÔÇÖIA stoppe net **Double ta mise**. Les **${totalPool.toLocaleString('fr-FR')} kamas** restent au chaud, et lÔÇÖambition humaine repart avec ses chaussures pleines de poussi├¿re.`
      },
      {
        title: 'Le billet retourne au comptoir',
        description:
          `${winnerHorseEmoji} **${winnerName}** r├¿gle lÔÇÖaffaire proprement, sans m├¬me faire semblant de douter.\n\n` +
          `La formule **Double ta mise** sÔÇÖ├®teint ici. Ce nÔÇÖest pas dramatique, juste l├®g├¿rement humiliant.`
      },
      {
        title: 'Le petit r├¬ve prend une claque',
        description:
          `${winnerHorseEmoji} **${winnerName}** remet les ambitions ├á leur place avec une froideur presque vexante.\n\n` +
          `**Double ta mise** se termine au guichet des regrets. Rien de tragique, juste un petit rappel que la piste ne distribue pas les sourires.`
      },
      {
        title: 'Le comptoir reprend son souffle',
        description:
          `${winnerHorseEmoji} **${winnerName}** ferme le dossier avec la s├®r├®nit├® dÔÇÖun patron qui sait d├®j├á o├╣ finit lÔÇÖargent.\n\n` +
          `LÔÇÖIA garde la main sur **Double ta mise**. CÔÇÖ├®tait tent├®, cÔÇÖ├®tait mignon, et cÔÇÖest d├®j├á fini.`
      },
    ]);
  }

  if (formulaLabel === 'Triple ta mise') {
    return pickRandom([
      {
        title: 'Le comptoir respire mieux',
        description:
          `${winnerHorseEmoji} **${winnerName}** ├®crase les illusions avec lÔÇÖassurance dÔÇÖun vieux patron qui conna├«t d├®j├á la fin de lÔÇÖhistoire.\n\n` +
          `LÔÇÖIA enterre **Triple ta mise** sans trembler. Les **${totalPool.toLocaleString('fr-FR')} kamas** restent ├á lÔÇÖabri, et cÔÇÖest probablement plus sage comme ├ºa.`
      },
      {
        title: 'Le pari gonfl├® retombe dÔÇÖun coup',
        description:
          `${winnerHorseEmoji} **${winnerName}** passe devant au moment exact o├╣ lÔÇÖespoir humain commen├ºait ├á devenir g├¬nant.\n\n` +
          `La formule **Triple ta mise** finit au tapis. Il fallait oser, il faudra maintenant encaisser.`
      },
      {
        title: 'Le PMU ferme le robinet',
        description:
          `${winnerHorseEmoji} **${winnerName}** coupe court aux r├¬ves dÔÇÖascension avec un sens du timing assez odieux.\n\n` +
          `**Triple ta mise** sÔÇÖarr├¬te ici. LÔÇÖorgueil humain voulait faire du bruit, lÔÇÖIA a pr├®f├®r├® faire le m├®nage.`
      },
      {
        title: 'La piste remet les pendules ├á lÔÇÖheure',
        description:
          `${winnerHorseEmoji} **${winnerName}** d├®roule sa course avec une autorit├® qui sent tr├¿s fort la le├ºon publique.\n\n` +
          `La formule **Triple ta mise** est aval├®e net. ├ça avait de lÔÇÖallure au d├®part, beaucoup moins ├á lÔÇÖarriv├®e.`
      },
    ]);
  }

  if (formulaLabel === 'Jackpot 2M') {
    return pickRandom([
      {
        title: 'Le PMU reprend son d├╗',
        description:
          `${winnerHorseEmoji} **${winnerName}** broie les espoirs sur la derni├¿re ligne droite avec le calme glacial dÔÇÖune machine venue humilier.\n\n` +
          `Le **Jackpot 2M** ne bougera pas aujourdÔÇÖhui. Les **${totalPool.toLocaleString('fr-FR')} kamas** restent bien au chaud, pendant que lÔÇÖaudace humaine retourne sÔÇÖasseoir au comptoir.`
      },
      {
        title: 'Le gros coup attendra',
        description:
          `${winnerHorseEmoji} **${winnerName}** ferme la porte au nez des r├¬veurs avec une ├®l├®gance presque vexante.\n\n` +
          `LÔÇÖIA garde la main sur le **Jackpot 2M**. Ce nÔÇÖ├®tait pas idiot dÔÇÖessayer, juste un peu na├»f.`
      },
      {
        title: 'Le coffre reste ferm├®',
        description:
          `${winnerHorseEmoji} **${winnerName}** referme la piste comme on referme un coffre-fort, sans ├®motion et sans laisser de t├®moin heureux.\n\n` +
          `Le **Jackpot 2M** reste au comptoir. Il faudra revenir avec autre chose que de lÔÇÖaudace et un beau discours.`
      },
      {
        title: 'Le r├¬ve finit au guichet des regrets',
        description:
          `${winnerHorseEmoji} **${winnerName}** transforme la derni├¿re ligne droite en le├ºon publique pour tous ceux qui pensaient faire plier le PMU.\n\n` +
          `Le **Jackpot 2M** ne tombera pas aujourdÔÇÖhui. Les r├¬ves de braquage retournent sÔÇÖasseoir, un peu moins fiers quÔÇÖen entrant.`
      },
    ]);
  }

  return pickRandom([
    {
      title: 'La machine ferme le d├®bat',
      description:
        `${winnerHorseEmoji} **${winnerName}** d├®vore la derni├¿re ligne droite sans le moindre ├®tat dÔÇÖ├óme.\n\n` +
        `LÔÇÖIA sÔÇÖimpose, la cagnotte de **${totalPool.toLocaleString('fr-FR')} kamas** reste ├á lÔÇÖorganisation, et les humains repartent avec leur fiert├® caboss├®e.`
    },
    {
      title: 'La piste rit en binaire',
      description:
        `${winnerHorseEmoji} **${winnerName}** surgit devant tout le monde avec lÔÇÖ├®l├®gance froide dÔÇÖun couperet.\n\n` +
        `LÔÇÖIA gagne. Les **${totalPool.toLocaleString('fr-FR')} kamas** restent au chaud, pendant que les mortels r├®visent leur confiance.`
    },
  ]);
}

function getHumanVictoryRoleNotification(winnerId, winnerName) {
  return pickRandom([
    `La piste a parl├®, et elle nÔÇÖa pas ├®t├® tendre, <@${winnerId}> sÔÇÖimpose avec **${winnerName}**. Les autres pourront toujours invoquer le vent.`,
    `<@${winnerId}> cloue le bec ├á la concurrence avec **${winnerName}**. Une victoire propre, ce qui rend lÔÇÖ├®chec des autres encore plus d├®coratif.`,
  ]);
}

function getAiVictoryRoleNotification(winnerName) {
  return pickRandom([
    `LÔÇÖIA sÔÇÖimpose avec **${winnerName}**. ├ètre battu par une machine nÔÇÖa jamais eu autant dÔÇÖallure, enfin presque.`,
    `**${winnerName}** offre la victoire ├á lÔÇÖIA. Les humains ont tent├® quelque chose, cÔÇÖest d├®j├á une forme de po├®sie.`,
  ]);
}

async function sendRoleNotification(channel, content, embeds = [], deleteAfterSeconds = ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, mentionRole = true) {
  if (!channel || !channel.isTextBased()) return null;

  const finalContent = mentionRole && NOTIF_ROLE_ID ? `${notifRoleMention()} ${content}` : content;

  try {
    const msg = await safeSend(channel, {
      content: finalContent,
      embeds,
      allowed_mentions: mentionRole ? notifAllowedMentions() : { parse: [] },
    });

    if (deleteAfterSeconds && deleteAfterSeconds > 0) {
      setTimeout(() => {
        safeDeleteMessage(msg).catch(() => {});
      }, deleteAfterSeconds * 1000);
    }

    return msg;
  } catch (error) {
    logException('sendRoleNotification', error);
    return null;
  }
}

function getUserFinance(userId) {
  const uid = String(userId);
  if (!finance[uid]) {
    finance[uid] = {
      total_debt: 0,
      bets_count: 0,
      payments_count: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    saveFinance();
  }
  return finance[uid];
}

function getUserDebt(userId) {
  return Number(getUserFinance(userId).total_debt || 0);
}

function addUserDebt(userId, amount) {
  const data = getUserFinance(userId);
  data.total_debt += amount;
  data.bets_count += 1;
  data.updated_at = nowIso();
  saveFinance();
}

function applyUserPayment(userId, amount) {
  const data = getUserFinance(userId);
  data.total_debt = Math.max(0, data.total_debt - amount);
  data.payments_count += 1;
  data.updated_at = nowIso();
  saveFinance();
}

function removeUserDebt(userId, amount) {
  const data = getUserFinance(userId);
  data.total_debt = Math.max(0, data.total_debt - amount);
  data.updated_at = nowIso();
  saveFinance();
}

function memberHasAllowedRole(member) {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (!ALLOWED_ROLE_IDS.length) return true;
  return ALLOWED_ROLE_IDS.some((rid) => member.roles.cache.has(rid));
}

function canUserPlay(member) {
  if (!memberHasAllowedRole(member)) {
    const rolesText = ALLOWED_ROLE_IDS.length ? `\nR├┤les autoris├®s : ${ALLOWED_ROLE_IDS.map((rid) => `<@&${rid}>`).join(', ')}` : '';
    return [false, `Tu n'as pas acc├¿s ├á ce jeu.${rolesText}`];
  }
  const debt = getUserDebt(member.id);
  if (debt > DEBT_LIMIT) {
    const amountToClear = debt - DEBT_LIMIT;
    return [false, `Acc├¿s bloqu├®.\nTa dette actuelle est de **${debt.toLocaleString('fr-FR')} kamas**.\nTu dois r├®gler au moins **${amountToClear.toLocaleString('fr-FR')} kamas** pour repasser sous la limite autoris├®e.`];
  }
  return [true, null];
}

function totalOutstandingDebt() {
  return Object.values(finance).reduce((sum, v) => sum + Number(v?.total_debt || 0), 0);
}

function totalOutstandingPayouts() {
  return Object.values(payoutRecords).reduce((sum, rec) => rec?.status === 'pending' ? sum + Number(rec?.total_amount || 0) : sum, 0);
}

function pendingPayoutsCount() {
  return Object.values(payoutRecords).filter((rec) => rec?.status === 'pending').length;
}

function indebtedPlayersCount() {
  return Object.values(finance).filter((v) => Number(v?.total_debt || 0) > 0).length;
}

function grossProfit() {
  return Number(stats.total_bets || 0) - Number(stats.total_gains || 0);
}

function aiWinrate() {
  const total = Number(stats.total_races || 0);
  const aiWins = Number(stats.ai_wins || 0);
  return total > 0 ? Math.round((aiWins / total) * 1000) / 10 : 0;
}

function getMatchmakingRemainingSeconds() {
  if (!waitingForPlayers || !matchmakingStartedAt) return 0;
  const elapsed = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
  let remaining = Math.max(0, WAIT_TIME - elapsed);
  if (fullLobbyDeadlineAt) {
    remaining = Math.min(remaining, Math.max(0, Math.ceil((fullLobbyDeadlineAt - Date.now()) / 1000)));
  }
  return remaining;
}

function isJoinWindowLocked() {
  return waitingForPlayers && getMatchmakingRemainingSeconds() <= JOIN_LOCK_LAST_SECONDS;
}

function canCancelParticipationNow() {
  if (!waitingForPlayers || !matchmakingStartedAt) return false;
  const elapsed = Math.floor((Date.now() - matchmakingStartedAt) / 1000);
  return elapsed < MATCH_CANCEL_WINDOW_SECONDS;
}

function canJoinButtonBeEnabled() {
  if (cooldown || raceInProgress || iaPendingLaunch) return false;
  if (waitingForPlayers) return currentPlayers.length < expectedHumans && !isJoinWindowLocked();
  return true;
}

function resetPlayersState() {
  currentPlayers = [];
  playerHorses = {};
  playerMode = {};
  matchmakingStartedAt = 0;
  fullLobbyDeadlineAt = 0;
  matchLaunchInProgress = false;
}

function clearRaceWatchMessage() {
  if (raceWatchMessage) {
    safeDeleteMessage(raceWatchMessage).catch(() => {});
    raceWatchMessage = null;
  }
}

function clearIaPendingLaunch() {
  iaPendingLaunch = false;
  iaPendingUserId = null;
  iaPendingCount = 0;
  iaPendingChannelId = null;
  iaPendingToken = null;

  if (iaStartTask) {
    clearTimeout(iaStartTask);
    iaStartTask = null;
  }

  if (iaCountdownIntervalTask) {
    clearInterval(iaCountdownIntervalTask);
    iaCountdownIntervalTask = null;
  }

  if (iaCountdownMessage) {
    safeDeleteMessage(iaCountdownMessage).catch(() => {});
    iaCountdownMessage = null;
  }

  if (iaStartThreadMessage) {
    safeDeleteMessage(iaStartThreadMessage).catch(() => {});
    iaStartThreadMessage = null;
  }
}

function stopMatchmakingTimers() {
  if (waitTask) { clearInterval(waitTask); waitTask = null; }
  if (waitTimeoutTask) { clearTimeout(waitTimeoutTask); waitTimeoutTask = null; }
}

function newMatchSessionId() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function downloadImage() {
  if (fs.existsSync(IMAGE_FILENAME)) return;
  try {
    const res = await fetch(IMAGE_URL);
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(IMAGE_FILENAME, buffer);
  } catch {}
}

async function cancelDebtRecord(recordId, cancelledByUserId = null) {
  if (!recordId) return false;
  const record = debtRecords[recordId];
  if (!record) return false;
  if (record.status !== 'unpaid') return false;

  record.status = 'cancelled';
  record.cancelled_at = nowIso();
  record.cancelled_by_user_id = cancelledByUserId ? String(cancelledByUserId) : null;
  saveDebtRecords();

  removeUserDebt(record.user_id, record.amount);

  try {
    const msg = await safeFetchMessage(record.channel_id, record.message_id);
    if (msg) {
      const existingEmbed = msg.embeds?.[0];
      const fallbackDescription =
        `**Joueur :** <@${record.user_id}>\n` +
        `**Montant :** ${Number(record.amount || 0).toLocaleString('fr-FR')} kamas\n` +
        `**Statut :** Participation annul├®e avant le d├®part`;

      const embed = existingEmbed
        ? EmbedBuilder.from(existingEmbed)
            .setColor(0x95A5A6)
            .setDescription((existingEmbed?.description || '').replace('En attente de paiement', 'Participation annul├®e avant le d├®part'))
            .setFooter({ text: `Annul├® le ${new Date().toLocaleString('fr-FR')}` })
        : new EmbedBuilder()
            .setTitle('Engagement de participation')
            .setDescription(fallbackDescription)
            .setColor(0x95A5A6)
            .setTimestamp(utcnow());

      await safeEditMessage(msg, { embeds: [embed], components: [] });
    }
  } catch (error) {
    logException('cancelDebtRecord.editMessage', error);
  }

  return true;
}

async function cancelUserParticipationDebt(userId) {
  const mode = playerMode[userId];
  if (!mode?.debt_record_id) return false;
  const cancelled = await cancelDebtRecord(mode.debt_record_id, userId);
  if (cancelled) await updateDashboard().catch(() => {});
  return cancelled;
}

// =========================================================
// R├ëSERVATION TEMPORAIRE
// =========================================================

function reservationIsActive() {
  if (!currentReservation) return false;
  if (Date.now() >= currentReservation.expires_at) {
    currentReservation = null;
    return false;
  }
  return true;
}

function clearReservation() {
  currentReservation = null;
  if (reservationTask) clearTimeout(reservationTask);
  reservationTask = null;
}

function createReservation(userId) {
  const token = crypto.randomUUID().replace(/-/g, '');
  currentReservation = {
    user_id: userId,
    token,
    expires_at: Date.now() + PENDING_RESERVATION_SECONDS * 1000,
  };
  if (reservationTask) clearTimeout(reservationTask);
  reservationTask = setTimeout(async () => {
    if (currentReservation?.token === token) {
      currentReservation = null;
      reservationTask = null;
      if (mainMessage) {
        try { await updateMainMessage(mainMessage.channel); } catch {}
      }
    }
  }, PENDING_RESERVATION_SECONDS * 1000);
  return token;
}

function reservationOwnedBy(userId, token) {
  return !!(currentReservation && currentReservation.user_id === userId && currentReservation.token === token && reservationIsActive());
}

// =========================================================
// BUILDERS UI
// =========================================================

function joinButtonRow() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join:main').setLabel('🐎 Participer').setStyle(ButtonStyle.Success).setDisabled(!canJoinButtonBeEnabled())
  )];
}

function modeChoiceRows(userId, token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mode:ia:${userId}:${token}`).setLabel("🤖 Contre l'IA").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mode:players:${userId}:${token}`).setLabel("⚔️ Contre d'autres joueurs").setStyle(ButtonStyle.Success)
  )];
}

function countChoiceRows(userId, token, selectedMode) {
  if (selectedMode === 'ia') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`count:${selectedMode}:55k:100k:${userId}:${token}`).setLabel('­ƒÆ░ Double ta mise').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`count:${selectedMode}:110k:300k:${userId}:${token}`).setLabel('­ƒÆÄ Triple ta mise').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`count:${selectedMode}:220k:2000k:${userId}:${token}`).setLabel('­ƒææ Jackpot 2M').setStyle(ButtonStyle.Danger)
    )];
  }

  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`count:${selectedMode}:1:${userId}:${token}`).setLabel('1').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`count:${selectedMode}:2:${userId}:${token}`).setLabel('2').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`count:${selectedMode}:3:${userId}:${token}`).setLabel('3').setStyle(ButtonStyle.Primary)
  )];
}

function iaJackpotConfirmRows(userId, token) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`iaconfirm:220k:2000k:${userId}:${token}`).setLabel('✅ Oui, je mise 220 000').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`iaback:${userId}:${token}`).setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary)
  )];
}

function horseChoiceRows(userId, contextMode, selectedMode, selectedCount, token = null) {
  const takenHorses = new Set();
  if (contextMode === 'join_waiting') {
    for (const uid of currentPlayers) {
      if (playerHorses[uid] !== undefined) takenHorses.add(playerHorses[uid]);
    }
  }

  return [new ActionRowBuilder().addComponents(
    ...HORSES.map((horse, i) => new ButtonBuilder()
      .setCustomId(`horse:${contextMode}:${selectedMode}:${selectedCount ?? 'null'}:${i}:${userId}:${token || 'none'}`)
      .setLabel(horse.name)
      .setEmoji(horse.emoji)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(takenHorses.has(i)))
  )];
}

function cancelParticipationRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cancel:${userId}`).setLabel('❌ Annuler ma participation').setStyle(ButtonStyle.Danger)
  )];
}

function cancelIaLaunchRows(userId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cancelia:${userId}`).setLabel('❌ Annuler cette course IA').setStyle(ButtonStyle.Danger)
  )];
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
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(textChannels.map((ch) => new StringSelectMenuOptionBuilder().setLabel(ch.name).setValue(ch.id)));
  return new ActionRowBuilder().addComponents(menu);
}

function channelSearchButtonRow(type) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`config:search:${type}`)
      .setLabel(type === 'logs' ? '🔎 Rechercher salon logs' : '🔎 Rechercher salon dashboard')
      .setStyle(ButtonStyle.Secondary)
  );
}

function roleSelectRow(guild, customId, placeholder, maxValues = 1) {
  const roles = guild.roles.cache.filter((role) => role.id !== guild.id).sort((a, b) => b.position - a.position).first(25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(0)
    .setMaxValues(Math.min(maxValues, roles.length || 1))
    .addOptions(roles.map((role) => new StringSelectMenuOptionBuilder().setLabel(role.name).setValue(role.id)));
  return new ActionRowBuilder().addComponents(menu);
}

function configRows(guild) {
  return [
    channelSelectRow(guild, 'config:logs_channel', 'Salon des logs (suivi des gains)'),
    channelSelectRow(guild, 'config:dashboard_channel', 'Salon du dashboard'),
    roleSelectRow(guild, 'config:admin_role', 'R├┤le admin (valider les paiements)', 1),
    roleSelectRow(guild, 'config:allowed_roles', 'R├┤le autoris├® ├á jouer (sert aussi pour les notifications)', 1),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('config:validate').setLabel('✅ Valider la configuration').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('config:cancel').setLabel('❌ Annuler').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

const configDrafts = new Map();
let setupInProgressByUser = new Set();

function getConfigDraft(userId) {
  if (!configDrafts.has(userId)) {
    configDrafts.set(userId, {
      logs_channel_id: null,
      dashboard_channel_id: null,
      admin_role_id: null,
      notification_role_id: null,
      allowed_role_ids: [],
    });
  }
  return configDrafts.get(userId);
}

// =========================================================
// AFFICHAGE / EMBEDS
// =========================================================

function getMainMessageContent(timer = null) {
  let content = '**🐎 PMU de la Guilde , mise sur ta Dragodinde ! 🐎💰**\n\n';
  content += 'Bienvenue au **PMU de la Guilde**.\n';
  content += 'Ici, on ne vient pas caresser la piste. On vient poser sa mise, serrer les dents, et espérer que sa Dragodinde ait plus de cœur que son propriétaire.\n\n';
  content += '**💸 Mises et règles**\n';
  content += `• **Course entre joueurs** : entrée à **${ENTRY_FEE.toLocaleString('fr-FR')} kamas**\n`;
  content += `• **Somme réellement mise en jeu** : **${REAL_BET.toLocaleString('fr-FR')} kamas** par joueur\n`;
  content += `• **Blocage dette** : au-delà de **${DEBT_LIMIT.toLocaleString('fr-FR')} kamas** de dette, le PMU te coupe le sifflet\n\n`;
  content += '**🎯 Défis contre l\'IA**\n';
  content += `• **💰 Double ta mise** , mise **${ENTRY_FEE.toLocaleString('fr-FR')} kamas** , gain final **100 000 kamas**\n`;
  content += '• **💎 Triple ta mise** , mise **105 000 kamas** , gain final **300 000 kamas**\n';
  content += '• **👑 Jackpot 2M** , mise **220 000 kamas** , gain final **2 000 000 kamas**\n\n';
  content += '**🏁 Comment jouer ?**\n';
  content += '• Clique sur **Participer**\n';
  content += '• Choisis ton mode\n';
  content += '• Sélectionne ta formule ou ton défi\n';
  content += '• Choisis ta Dragodinde\n';
  content += '• Puis regarde si tu repars avec des kamas... ou juste avec la honte\n\n';
  content += '**📌 À savoir**\n';
  content += '• En **course entre joueurs**, si la grille n’est pas complète, l’IA prend les places libres au départ\n';
  content += '• En **mode IA**, le gain est **fixe** selon la formule choisie\n';
  content += '• Les gains, dettes et paiements sont suivis automatiquement par le PMU\n\n';
  content += '**💀 Dettes & recouvrement**\n';
  content += '• Le récupérateur officiel des dettes, c’est **Tonymerguez**\n';
  content += '• Tant que tu paies, tout va bien, on reste entre gens civilisés\n';
  content += '• Si tu commences à faire le mort, à gratter du temps ou à oublier ton ardoise, ça finit rarement dans la tendresse\n';
  content += '• En clair, joue si tu veux, fanfaronne si tu gagnes, mais **si tu paies pas, ça va puer la merde pour toi**\n\n';

  if (reservationIsActive() && !waitingForPlayers && !raceInProgress && !cooldown) {
    const remaining = Math.max(0, Math.floor((currentReservation.expires_at - Date.now()) / 1000));
    content += `ÔÅ│ **R├®servation en cours** pour <@${currentReservation.user_id}> pendant encore **${remaining} sec**\n\n`;
  }

  if (iaPendingLaunch && iaPendingUserId) {
    content += `­ƒñû **D├®part contre l'IA en pr├®paration** pour <@${iaPendingUserId}>\n`;
    content += `­ƒñû IA pr├®vues : **${iaPendingCount}**\n`;
    content += `ÔØî Annulation possible pendant **${IA_CANCEL_WINDOW_SECONDS} secondes**\n`;
    content += `­ƒÅü D├®part automatique au bout de **${IA_PRESTART_SECONDS} secondes**\n\n`;
  }

  if (timer !== null && timer > 0) {
    content += `ÔÅ▒´©Å **Prochaine course disponible dans : ${timer} secondes**\n\n`;
  } else if (cooldown) {
    const remaining = Math.max(0, Math.floor((cooldownEndTime - Date.now()) / 1000));
    content += `ÔÅ▒´©Å **Prochaine course disponible dans : ${remaining} secondes**\n\n`;
  }

  if (waitingForPlayers) {
    content += `­ƒæÑ **Recherche d'adversaires en cours** : ${currentPlayers.length}/${expectedHumans}\n`;
    content += `ÔÅ▒´©Å **D├®part dans :** ${getMatchmakingRemainingSeconds()} sec\n`;
    content += `­ƒöÆ **Inscriptions :** ${isJoinWindowLocked() ? 'ferm├®es' : 'ouvertes'}\n`;
    content += `ÔØî **Annulation possible :** ${canCancelParticipationNow() ? 'oui' : 'non'}\n\n`;
  }

  content += '**­ƒÆ░ Participants actuels :**\n';
  if (currentPlayers.length) {
    for (const uid of currentPlayers) {
      const hidx = playerHorses[uid];
      const horseStr = hidx !== undefined ? `${HORSES[hidx].emoji} ${HORSES[hidx].name}` : 'ÔØô';
      content += `ÔÇó <@${uid}> , ${horseStr}\n`;
    }
  } else {
    content += 'Aucun participant pour l\'instant.\n';
  }

  content += `\n*Capacit├® max : ${MAX_PLAYERS} joueurs humains*`;
  return content;
}

function buildRaceStatusEmbed(phase, { creatorId = null, humans = [], aiCount = 0, pot = 0, winnerId = null, winnerName = null, horsesSnapshot = null, reason = null } = {}) {
  const colorMap = {
    waiting: 0xF1C40F,
    launching: 0x3498DB,
    running: 0x9B59B6,
    finished: 0x2ECC71,
    cancelled: 0xE74C3C,
  };

  const embed = new EmbedBuilder()
    .setTitle('­ƒÅç Course Dragodinde')
    .setColor(colorMap[phase] ?? 0x3498DB)
    .setTimestamp(utcnow());

  if (phase === 'waiting') {
    const remaining = getMatchmakingRemainingSeconds();
    const joinLocked = remaining <= JOIN_LOCK_LAST_SECONDS;
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription(`**<@${creatorId}>** cherche des adversaires.\nInscrits : **${humans.length}/${expectedHumans}**\nPlaces restantes : **${Math.max(0, expectedHumans - humans.length)}**`)
      .addFields(
        { name: '­ƒÆ░ Joueurs engag├®s', value: humanHorseLines(humans, horsesSnapshot), inline: false },
        { name: '­ƒÅå Cagnotte actuelle', value: `${(REAL_BET * humans.length).toLocaleString('fr-FR')} kamas`, inline: false },
        { name: 'ÔÅ▒´©Å D├®part dans', value: `${remaining} sec`, inline: true },
        { name: '­ƒöÆ Inscriptions', value: joinLocked ? 'Ferm├®es' : 'Ouvertes', inline: true },
        { name: 'ÔØî D├®sistement', value: canCancelParticipationNow() ? 'Autoris├®' : 'Verrouill├®', inline: true }
      );
  } else if (phase === 'launching') {
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription('La grille s\'ouvre, les sabots frappent le sol, la course se pr├®pare...')
      .addFields(
        { name: '­ƒÆ░ Joueurs humains', value: humanHorseLines(humans, horsesSnapshot), inline: false },
        { name: '­ƒñû IA ajout├®es', value: String(aiCount), inline: true },
        { name: '­ƒÆ░ Cagnotte', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: true }
      );
  } else if (phase === 'running') {
    embed
      .setImage(RACE_BANNER_URL)
      .setDescription('La course est lanc├®e ! Les dragodindes sont sur la piste.')
      .addFields(
        { name: 'Participants', value: humanHorseLines(humans, horsesSnapshot), inline: false },
        { name: '­ƒñû IA en piste', value: String(aiCount), inline: true },
        { name: '­ƒÆ░ Cagnotte', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: true }
      );
  } else if (phase === 'finished') {
    const winnerDisplay = winnerId && winnerId !== '0' ? `<@${winnerId}>` : 'IA';
    embed
      .setImage(RESULT_IMAGE_URL)
      .setDescription('La poussi├¿re retombe. La piste a rendu son verdict.')
      .addFields(
        { name: '­ƒÅå Vainqueur', value: `${winnerDisplay} (${winnerName || ''})`, inline: false },
        { name: '­ƒÆ░ Montant', value: `${pot.toLocaleString('fr-FR')} kamas`, inline: false }
      );
    if (humans.length) {
      embed.addFields({ name: '­ƒÆ░ Participants', value: humanHorseLines(humans, horsesSnapshot), inline: false });
    }
  } else if (phase === 'cancelled') {
    embed.setDescription(reason || 'La recherche dÔÇÖadversaires a ├®t├® interrompue.');
  }

  return embed;
}

async function upsertRaceAnnouncement(channel, embed) {
  try {
    if (!raceAnnouncementMsg) raceAnnouncementMsg = await safeSend(channel, { embeds: [embed] });
    else await safeEditMessage(raceAnnouncementMsg, { content: null, embeds: [embed], components: [] });
  } catch (error) {
    logException('upsertRaceAnnouncement', error);
  }
}

async function updateRaceWatchMessage(channel, thread, label = '­ƒöù Regarder la course') {
  try {
    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${channel.guild.id}/${thread.id}`)
    );
    if (!raceWatchMessage) raceWatchMessage = await safeSend(channel, { content: '­ƒÄ» La course est pr├¬te.', components: [button] });
    else await safeEditMessage(raceWatchMessage, { content: '­ƒÄ» La course est pr├¬te.', components: [button] });
  } catch (error) {
    logException('updateRaceWatchMessage', error);
  }
}

// =========================================================
// DETTES / DASHBOARD
// =========================================================

async function createDebtRecord(userId, horseIndex, amount = ENTRY_FEE, meta = {}) {
  const channel = getLogsChannel();
  if (!channel) return null;

  const recordId = crypto.randomUUID().replace(/-/g, '');
  const safeAmount = Number(amount || ENTRY_FEE);
  const futureTotal = getUserDebt(userId) + safeAmount;
  const formulaText = meta.formula_label ? `**Formule :** ${meta.formula_label}\n` : '';

  const embed = new EmbedBuilder()
    .setTitle('­ƒÆ░ Engagement de participation')
    .setDescription(
      `**Joueur :** <@${userId}>\n` +
      `**Montant :** ${safeAmount.toLocaleString('fr-FR')} kamas\n` +
      formulaText +
      `**Cheval :** ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}\n` +
      `**Dette totale apr├¿s inscription :** ${futureTotal.toLocaleString('fr-FR')} kamas\n` +
      `**Statut :** ÔÅ│ En attente de paiement`
    )
    .setColor(0xFFA500)
    .setTimestamp(utcnow());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`debtpay:${recordId}`).setLabel('✅ Valider le paiement').setStyle(ButtonStyle.Success)
  );

  try {
    const msg = await safeSend(channel, { embeds: [embed], components: [row] });
    debtRecords[recordId] = {
      record_id: recordId,
      user_id: String(userId),
      amount: safeAmount,
      horse_index: horseIndex,
      formula_label: meta.formula_label || null,
      mode: meta.mode || null,
      status: 'unpaid',
      channel_id: channel.id,
      message_id: msg.id,
      created_at: nowIso(),
      paid_at: null,
      paid_by_admin_id: null,
      cancelled_at: null,
      cancelled_by_user_id: null,
    };
    saveDebtRecords();
    addUserDebt(userId, safeAmount);
    await updateDashboard();
    return recordId;
  } catch (error) {
    logException('createDebtRecord', error);
    return null;
  }
}

async function ensureDashboardMessage() {
  if (!DASHBOARD_CHANNEL_ID) return null;
  if (DASHBOARD_MESSAGE_ID) {
    const existing = await safeFetchMessage(DASHBOARD_CHANNEL_ID, DASHBOARD_MESSAGE_ID);
    if (existing) return existing;
  }

  const channel = client.channels.cache.get(DASHBOARD_CHANNEL_ID) || await client.channels.fetch(DASHBOARD_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const msg = await safeSend(channel, {
    embeds: [new EmbedBuilder().setTitle('­ƒôè TABLEAU DE BORD DES COURSES').setDescription('Vue synth├®tique de lÔÇÖactivit├®, des dettes et de la rentabilit├® du jeu.').setColor(0x00AAFF).setTimestamp(utcnow())],
  });

  DASHBOARD_MESSAGE_ID = msg.id;
  config.dashboard_message_id = msg.id;
  saveConfig();
  return msg;
}

async function createPayoutRecord(userId, horseIndex, grossAmount, refundedStake, totalAmount, participantsSnapshot, winnerName) {
  const channel = getLogsChannel();
  if (!channel) return null;

  const recordId = crypto.randomUUID().replace(/-/g, '');
  const participantsText = participantsSnapshot.map((uid) => `<@${uid}>`).join(', ') || 'Aucun';

  const embed = new EmbedBuilder()
    .setTitle('­ƒÅå Gain ├á remettre')
    .setDescription(
      `**Gagnant :** <@${userId}>\n` +
      `**Cheval :** ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}\n` +
      `**Nom de la dragodinde :** ${winnerName}\n` +
      `**Gain course :** ${Number(grossAmount).toLocaleString('fr-FR')} kamas\n` +
      `**Mise rendue :** ${Number(refundedStake).toLocaleString('fr-FR')} kamas\n` +
      `**Total ├á remettre :** ${Number(totalAmount).toLocaleString('fr-FR')} kamas\n` +
      `**Participants :** ${participantsText}\n` +
      `**Statut :** ÔÅ│ En attente de remise`
    )
    .setColor(0x2ECC71)
    .setTimestamp(utcnow());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`payoutpay:${recordId}`).setLabel('✅ Valider le gain').setStyle(ButtonStyle.Success)
  );

  try {
    const msg = await safeSend(channel, { embeds: [embed], components: [row] });
    payoutRecords[recordId] = {
      record_id: recordId,
      user_id: String(userId),
      horse_index: horseIndex,
      winner_name: winnerName,
      gross_amount: Number(grossAmount),
      refunded_stake: Number(refundedStake),
      total_amount: Number(totalAmount),
      participants: participantsSnapshot.map(String),
      status: 'pending',
      channel_id: channel.id,
      message_id: msg.id,
      created_at: nowIso(),
      paid_at: null,
      paid_by_admin_id: null,
    };
    savePayoutRecords();
    await updateDashboard();
    return recordId;
  } catch (error) {
    logException('createPayoutRecord', error);
    return null;
  }
}

async function logRaceResult(participantsSnapshot, horsesSnapshot, winnerId, winnerName, totalPool) {
  const channel = getLogsChannel();
  if (!channel) return;

  const participantsLines = participantsSnapshot.map((uid) => {
    const horseIdx = horsesSnapshot[uid];
    if (horseIdx === undefined || horseIdx === null) return `ÔÇó <@${uid}> , Cheval inconnu`;
    return `ÔÇó <@${uid}> , ${HORSES[horseIdx].emoji} ${HORSES[horseIdx].name}`;
  });

  const winnerDisplay = winnerId !== 0 && winnerId !== '0' ? `<@${winnerId}>` : 'IA';

  const embed = new EmbedBuilder()
    .setTitle('­ƒÅü R├®sultat de course')
    .setImage(RESULT_IMAGE_URL)
    .setFooter({ text: 'Mise sur ta Dragodinde , R├®sultat officiel' })
    .setDescription(
      `**Vainqueur :** ${winnerDisplay} (${winnerName})\n` +
      `**Cagnotte distribu├®e :** ${totalPool.toLocaleString('fr-FR')} kamas\n\n` +
      `**Participants :**\n${participantsLines.join('\n')}`
    )
    .setColor(0x00FF00)
    .setTimestamp(utcnow());

  try { await safeSend(channel, { embeds: [embed] }); } catch (error) { logException('logRaceResult', error); }
}

async function updateStatsAfterRace(participantsSnapshot, winnerId, winnerName, totalPool) {
  stats.total_gains += totalPool;
  stats.total_bets += ENTRY_FEE * participantsSnapshot.length;
  stats.total_races += 1;
  if (Number(winnerId) === 0) stats.ai_wins = Number(stats.ai_wins || 0) + 1;
  if (Number(winnerId) !== 0) {
    const wid = String(winnerId);
    stats.top_winners[wid] = Number(stats.top_winners[wid] || 0) + totalPool;
  }
  stats.last_race = {
    winner_id: Number(winnerId),
    winner_name: winnerName,
    gains: totalPool,
    participants: participantsSnapshot,
    timestamp: nowIso(),
  };
  saveStats();
  await updateDashboard();
}

async function updateDashboard() {
  if (!DASHBOARD_CHANNEL_ID) return;
  const msg = await ensureDashboardMessage();
  if (!msg) return;

  const pending = Object.values(debtRecords).filter((rec) => rec?.status === 'unpaid').length;
  const top = Object.entries(stats.top_winners || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5);
  const topText = top.length ? top.map(([uid, gains]) => `<@${uid}> : ${Number(gains).toLocaleString('fr-FR')} kamas`).join('\n') : 'Aucun';
  const mostIndebted = Object.entries(finance)
    .map(([uid, data]) => [uid, Number(data?.total_debt || 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const debtText = mostIndebted.filter(([, amount]) => amount > 0).length
    ? mostIndebted.filter(([, amount]) => amount > 0).map(([uid, amount]) => `<@${uid}> : ${amount.toLocaleString('fr-FR')} kamas`).join('\n')
    : 'Aucune dette';

  const embed = new EmbedBuilder()
    .setTitle('­ƒôè TABLEAU DE BORD DES COURSES')
    .setDescription('Vue synth├®tique de lÔÇÖactivit├®, des dettes et de la rentabilit├® du jeu.')
    .setColor(0x00AAFF)
    .setTimestamp(utcnow())
    .addFields(
      { name: '­ƒÅü Courses r├®alis├®es', value: String(stats.total_races || 0), inline: true },
      { name: '­ƒÆ░ Mises totales', value: `${Number(stats.total_bets || 0).toLocaleString('fr-FR')} kamas`, inline: true },
      { name: '­ƒÅå Gains distribu├®s', value: `${Number(stats.total_gains || 0).toLocaleString('fr-FR')} kamas`, inline: true },
      { name: '­ƒÆ© B├®n├®fice brut', value: `${grossProfit().toLocaleString('fr-FR')} kamas`, inline: true },
      { name: '­ƒÆ│ Dette totale ├á encaisser', value: `${totalOutstandingDebt().toLocaleString('fr-FR')} kamas`, inline: true },
      { name: '­ƒÆ© Gains ├á remettre', value: `${totalOutstandingPayouts().toLocaleString('fr-FR')} kamas`, inline: true },
      { name: '­ƒñû Winrate IA', value: `${aiWinrate()}%`, inline: true },
      { name: '­ƒôî Dettes impay├®es', value: String(pending), inline: true },
      { name: '­ƒÄü Gains en attente', value: String(pendingPayoutsCount()), inline: true },
      { name: '­ƒÅå Top gagnants', value: topText, inline: false },
      { name: '­ƒÆ│ Top dettes', value: debtText, inline: false }
    );

  const last = stats.last_race || {};
  if (last && last.winner_id !== null && last.winner_id !== undefined) {
    const participantsText = Array.isArray(last.participants) && last.participants.length ? last.participants.map((uid) => `<@${uid}>`).join(', ') : 'Aucun';
    const winnerDisplay = Number(last.winner_id) !== 0 ? `<@${last.winner_id}>` : 'IA';
    embed.addFields({
      name: '­ƒÄ» Derni├¿re course',
      value: `Gagnant : ${winnerDisplay} (${last.winner_name || ''})\nGains : ${Number(last.gains || 0).toLocaleString('fr-FR')} kamas\nParticipants : ${participantsText}`,
      inline: false,
    });
  } else {
    embed.addFields({ name: '­ƒÄ» Derni├¿re course', value: 'Aucune', inline: false });
  }

  try { await safeEditMessage(msg, { embeds: [embed] }); } catch (error) { logException('updateDashboard', error); }
}

// =========================================================
// COURSE / TRACK
// =========================================================

function humanHorseLines(userIds, horsesSnapshot = null) {
  const source = horsesSnapshot || playerHorses;
  return userIds.map((uid) => {
    const horseIdx = source[uid];
    return horseIdx === undefined ? `<@${uid}> , cheval inconnu` : `${HORSES[horseIdx].emoji} <@${uid}> avec **${HORSES[horseIdx].name}**`;
  }).join('\n') || 'Aucun';
}

function generateTrack(positions, activeHorseIndexes = null) {
  const activeSet = new Set(activeHorseIndexes || [0, 1, 2, 3]);
  const raceData = [];

  for (let i = 0; i < HORSES.length; i++) {
    if (!activeSet.has(i)) continue;
    raceData.push({
      index: i,
      pos: positions[i],
      horse: HORSES[i],
    });
  }

  raceData.sort((a, b) => b.pos - a.pos);

  const rankIcons = ['­ƒÑç', '­ƒÑê', '­ƒÑë'];

  return raceData
    .map((entry, rank) => {
      const medal = rankIcons[rank] || `${rank + 1}e`;
      const slot = Math.max(0, Math.min(TRACK_LENGTH - 1, Math.floor((entry.pos / 100) * (TRACK_LENGTH - 1))));
      const before = 'ÔöÇ'.repeat(slot);
      const after = 'ÔöÇ'.repeat(Math.max(0, TRACK_LENGTH - slot - 1));
      return `${medal} ${entry.horse.emoji} ${entry.horse.name} ­ƒÅü${before}${entry.horse.emoji}${after}­ƒÅü ${entry.pos}%`;
    })
    .join('\n');
}

function randomRaceEvent(contestantsMap, horseIndex) {
  const entry = contestantsMap[horseIndex] || ['ai', null];
  const [typ, uid] = entry;
  const horse = HORSES[horseIndex];
  const prefix = typ === 'human' && uid ? `${horse.emoji} <@${uid}> avec **${horse.name}**` : `${horse.emoji} **${horse.name}** (IA)`;
  const events = [
    `${prefix} arrache un m├¿tre de plus avec une arrogance d├®licieuse !`,
    `${prefix} relance au bon moment, pendant que les autres n├®gocient avec leur destin !`,
    `${prefix} d├®bo├«te un rival sans m├¬me lui laisser le temps dÔÇÖy croire !`,
    `${prefix} glisse, se rattrape, et humilie quand m├¬me la concurrence !`,
    `${prefix} serre la trajectoire comme si la piste lui appartenait !`,
    `${prefix} retrouve du souffle, ce qui nÔÇÖarrange personne derri├¿re !`,
  ];
  return pickRandom(events);
}

function getLeaderPosition(positions, activeHorseIndexes) {
  return Math.max(...activeHorseIndexes.map((i) => positions[i]));
}

function getSecondPosition(positions, activeHorseIndexes, currentIndex) {
  const others = activeHorseIndexes.filter((i) => i !== currentIndex).map((i) => positions[i]);
  return others.length ? Math.max(...others) : 0;
}

function computeRaceAdvance(positions, horseIndex, horseToContestant, activeHorseIndexes, raceOptions = {}) {
  let advance = Math.floor(Math.random() * (RACE_STEP_MAX - RACE_STEP_MIN + 1)) + RACE_STEP_MIN;

  const leaderPos = getLeaderPosition(positions, activeHorseIndexes);
  const myPos = positions[horseIndex];
  const secondPos = getSecondPosition(positions, activeHorseIndexes, horseIndex);

  const gapBehindLeader = leaderPos - myPos;
  const gapAheadOfSecond = myPos - secondPos;

  if (gapBehindLeader >= COMEBACK_TRIGGER_GAP && Math.random() < COMEBACK_BONUS_CHANCE) {
    advance += 1;
  }

  if (gapAheadOfSecond >= LEADER_SLOWDOWN_GAP && Math.random() < LEADER_SLOWDOWN_CHANCE) {
    advance -= 1;
  }

  const isAi = horseToContestant[horseIndex]?.[0] === 'ai';
  const isJackpotBias = !!raceOptions.jackpotBias;

  if (isAi) {
    if (Math.random() < AI_SUBTLE_BONUS_CHANCE) advance += 1;
    if (Math.random() < AI_SUBTLE_MALUS_CHANCE) advance -= 1;
    if (isJackpotBias && Math.random() < 0.18) advance += 1;
  } else if (isJackpotBias && Math.random() < 0.12) {
    advance -= 1;
  }

  if (advance < 1) advance = 1;
  return advance;
}

async function runCountdown(thread, seconds, label = 'D├®part dans') {
  const msg = await safeSend(thread, {
    embeds: [new EmbedBuilder().setTitle('ÔÅ▒´©Å Pr├®-d├®part').setDescription(`${label} **${seconds}** secondes...`).setColor(0x3498DB).setImage(RACE_BANNER_URL).setTimestamp(utcnow())],
  });
  for (let s = seconds - 1; s >= 1; s--) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await safeEditMessage(msg, {
        embeds: [new EmbedBuilder().setTitle('ÔÅ▒´©Å Pr├®-d├®part').setDescription(`${label} **${s}** secondes...`).setColor(0x3498DB).setImage(RACE_BANNER_URL).setTimestamp(utcnow())],
      });
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1000));
  await safeDeleteMessage(msg);
}

async function runRaceWithRandomBonus(thread, contestants, raceOptions = {}) {
  const positions = [0, 0, 0, 0];
  const horseToContestant = {};
  const activeHorseIndexes = [];

  for (const [typ, uid, h] of contestants) {
    horseToContestant[h] = [typ, uid];
    activeHorseIndexes.push(h);
  }

  logInfo('===== COURSE START =====');
  for (const [typ, uid, h] of contestants) {
    logInfo(`Contestant: type=${typ}, uid=${uid}, horse=${HORSES[h].name}`);
  }

  await runCountdown(thread, 5, 'La course d├®marre dans');

  const animMsg = await safeSend(thread, {
    content: `­ƒÅç **D├®part** ­ƒÅç\n${generateTrack(positions, activeHorseIndexes)}`
  });
  await new Promise((r) => setTimeout(r, 1000));

  let winnerHorse = null;
  let loopCount = 0;

  while (winnerHorse === null) {
    loopCount += 1;

    const shuffled = [...activeHorseIndexes].sort(() => Math.random() - 0.5);

    for (const i of shuffled) {
      const advance = computeRaceAdvance(positions, i, horseToContestant, activeHorseIndexes, raceOptions);

      positions[i] += advance;
      if (positions[i] >= 100) {
        positions[i] = 100;
        winnerHorse = i;
        break;
      }
    }

    if (loopCount % 3 === 0 && Math.random() < 0.30) {
      const idx = activeHorseIndexes[Math.floor(Math.random() * activeHorseIndexes.length)];
      const e = await safeSend(thread, { content: randomRaceEvent(horseToContestant, idx) }).catch(() => null);
      if (e) setTimeout(() => safeDeleteMessage(e), 3200);
    }

    await safeEditMessage(animMsg, {
      content: `­ƒÅç **Course en cours** ­ƒÅç\n${generateTrack(positions, activeHorseIndexes)}`
    });
    await new Promise((r) => setTimeout(r, 1450));
  }

  const winnerEntry = horseToContestant[winnerHorse];
  if (!winnerEntry) throw new Error(`Aucun contestant trouv├® pour le cheval gagnant index=${winnerHorse}`);
  const [typ, uid] = winnerEntry;
  logInfo(`===== COURSE END ===== winner_type=${typ}, winner_uid=${uid}, winner_horse=${HORSES[winnerHorse].name}`);
  return [typ, uid, winnerHorse, HORSES[winnerHorse].name];
}

// =========================================================
// MAIN MESSAGE / TIMER
// =========================================================

async function updateWaitingMessage() {
  if (!raceAnnouncementMsg) return;
  const embed = buildRaceStatusEmbed('waiting', {
    creatorId: currentMatchCreatorId,
    humans: [...currentPlayers],
    pot: REAL_BET * currentPlayers.length,
    horsesSnapshot: { ...playerHorses },
  });
  try { await safeEditMessage(raceAnnouncementMsg, { content: null, embeds: [embed], components: [] }); } catch {}
}

async function updateMainMessage(channel, timer = null) {
  const content = getMainMessageContent(timer);
  const components = joinButtonRow();

  if (!mainMessage) {
    const payload = {
      content,
      components,
      embeds: [new EmbedBuilder().setColor(0xF1C40F).setImage(fs.existsSync(IMAGE_FILENAME) ? 'attachment://dragodinde.png' : IMAGE_URL)],
    };
    if (fs.existsSync(IMAGE_FILENAME)) payload.files = [new AttachmentBuilder(IMAGE_FILENAME, { name: 'dragodinde.png' })];
    mainMessage = await safeSend(channel, payload);
    try {
      await mainMessage.pin();
      setTimeout(() => deleteRecentSystemMessages(channel).catch(() => {}), 1500);
    } catch {}
    MAIN_CHANNEL_ID = channel.id;
    MAIN_MESSAGE_ID = mainMessage.id;
    config.main_channel_id = MAIN_CHANNEL_ID;
    config.main_message_id = MAIN_MESSAGE_ID;
    saveConfig();
  } else {
    try {
      await safeEditMessage(mainMessage, { content, components });
    } catch {
      mainMessage = null;
      await updateMainMessage(channel, timer);
    }
  }
}

async function updateTimerLoop(channel) {
  while (cooldown) {
    const remaining = Math.floor((cooldownEndTime - Date.now()) / 1000);
    if (remaining <= 0) break;
    try {
      if (!timerMessage) timerMessage = await safeSend(channel, { content: `ÔÅ▒´©Å Prochaine course dans **${remaining}** secondes...` });
      else await safeEditMessage(timerMessage, { content: `ÔÅ▒´©Å Prochaine course dans **${remaining}** secondes...` });
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (timerMessage) {
    await safeDeleteMessage(timerMessage);
    timerMessage = null;
  }
  await updateMainMessage(channel).catch(() => {});
}

async function finishRace(channel) {
  waitingForPlayers = false;
  raceInProgress = false;
  expectedHumans = 0;
  currentMatchCreatorId = null;
  currentMatchSessionId = null;

  stopMatchmakingTimers();
  resetPlayersState();
  clearReservation();
  clearIaPendingLaunch();

  cooldown = true;
  cooldownEndTime = Date.now() + COOLDOWN_AFTER_RACE * 1000;

  await updateMainMessage(channel).catch(() => {});

  if (timerTask) clearTimeout(timerTask);
  timerTask = setTimeout(async () => {
    cooldown = false;
    if (timerMessage) {
      await safeDeleteMessage(timerMessage);
      timerMessage = null;
    }
    if (raceAnnouncementMsg) {
      await safeDeleteMessage(raceAnnouncementMsg);
      raceAnnouncementMsg = null;
    }
    clearRaceWatchMessage();
    await updateMainMessage(channel).catch(() => {});
  }, COOLDOWN_AFTER_RACE * 1000);

  updateTimerLoop(channel).catch(() => {});
}

async function createRaceThread(channel, prefix) {
  const starter = await safeSend(channel, { content: '­ƒÅç' });
  const thread = await starter.startThread({
    name: `${prefix}-${Math.floor(Date.now() / 1000)}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  });
  setTimeout(() => deleteRecentSystemMessages(channel).catch(() => {}), 1200);
  return { starter, thread };
}

// =========================================================
// MODES DE COURSE
// =========================================================

function parseIaFormula(selection) {
  const [stakeCode, prizeCode] = String(selection || '').split('|');
  const table = {
    '55k|100k': { stake: 55_000, prize: 100_000, label: 'Double ta mise', aiCount: 3, commission: 5_000, jackpotBias: false },
    '110k|300k': { stake: 110_000, prize: 300_000, label: 'Triple ta mise', aiCount: 3, commission: 10_000, jackpotBias: false },
    '220k|2000k': { stake: 220_000, prize: 2_000_000, label: 'Jackpot 2M', aiCount: 3, commission: 20_000, jackpotBias: true },
  };
  return table[`${stakeCode}|${prizeCode}`] || null;
}

async function startIaRace(userId, channel, formula) {
  if (raceInProgress || waitingForPlayers || iaPendingLaunch) {
    const msg = await safeSend(channel, { content: 'ÔØî Une course est d├®j├á en cours.' });
    setTimeout(() => safeDeleteMessage(msg), 5000);
    return;
  }

  const launchToken = crypto.randomUUID().replace(/-/g, '');
  iaPendingLaunch = true;
  iaPendingUserId = userId;
  iaPendingCount = formula.aiCount;
  iaPendingChannelId = channel.id;
  iaPendingToken = launchToken;

  await updateMainMessage(channel);

  iaCountdownMessage = await safeSend(channel, {
    embeds: [
      new EmbedBuilder()
        .setTitle('ÔÅ▒´©Å Course IA programm├®e')
        .setDescription(
          `La course de <@${userId}> en formule **${formula.label}** contre **${formula.aiCount} IA** commencera dans **${IA_PRESTART_SECONDS} secondes**.\n` +
          `­ƒÄ» Gain potentiel : **${formula.prize.toLocaleString('fr-FR')} kamas**\n` +
          `Annulation possible pendant **${IA_CANCEL_WINDOW_SECONDS} secondes**.`
        )
        .setColor(0xF1C40F)
        .setImage(RACE_BANNER_URL)
        .setTimestamp(utcnow())
    ]
  }).catch(() => null);

  const countdownStartedAt = Date.now();

  iaCountdownIntervalTask = setInterval(async () => {
    try {
      if (!iaPendingLaunch || iaPendingToken !== launchToken) {
        if (iaCountdownIntervalTask) {
          clearInterval(iaCountdownIntervalTask);
          iaCountdownIntervalTask = null;
        }
        if (iaCountdownMessage) {
          await safeDeleteMessage(iaCountdownMessage);
          iaCountdownMessage = null;
        }
        return;
      }

      const elapsed = Math.floor((Date.now() - countdownStartedAt) / 1000);
      const remaining = Math.max(0, IA_PRESTART_SECONDS - elapsed);
      const cancelRemaining = Math.max(0, IA_CANCEL_WINDOW_SECONDS - elapsed);

      if (remaining <= 0) {
        if (iaCountdownIntervalTask) {
          clearInterval(iaCountdownIntervalTask);
          iaCountdownIntervalTask = null;
        }
        if (iaCountdownMessage) {
          await safeDeleteMessage(iaCountdownMessage);
          iaCountdownMessage = null;
        }
        return;
      }

      if (iaCountdownMessage) {
        await safeEditMessage(iaCountdownMessage, {
          embeds: [
            new EmbedBuilder()
              .setTitle('ÔÅ▒´©Å Course IA programm├®e')
              .setDescription(
                `La course de <@${userId}> en formule **${formula.label}** contre **${formula.aiCount} IA** commencera dans **${remaining} secondes**.\n` +
                `­ƒÄ» Gain potentiel : **${formula.prize.toLocaleString('fr-FR')} kamas**\n` +
                `Annulation ${cancelRemaining > 0 ? `possible pendant encore **${cancelRemaining} secondes**` : '**ferm├®e**'}.`
              )
              .setColor(cancelRemaining > 0 ? 0xF1C40F : 0xE67E22)
              .setImage(RACE_BANNER_URL)
              .setTimestamp(utcnow())
          ]
        }).catch(() => {});
      }
    } catch {
      if (iaCountdownIntervalTask) {
        clearInterval(iaCountdownIntervalTask);
        iaCountdownIntervalTask = null;
      }
    }
  }, 1000);

  iaStartTask = setTimeout(async () => {
    try {
      if (!iaPendingLaunch || iaPendingToken !== launchToken || iaPendingChannelId !== channel.id || waitingForPlayers) return;

      clearIaPendingLaunch();

      if (raceInProgress || waitingForPlayers) return;
      raceInProgress = true;
      await updateMainMessage(channel);

      const totalPool = formula.prize;
      const horsesSnapshot = { ...playerHorses };
      const humanHorseIdx = horsesSnapshot[userId];
      const humanHorseName = humanHorseIdx !== undefined ? HORSES[humanHorseIdx].name : 'Cheval inconnu';
      const humanHorseEmoji = humanHorseIdx !== undefined ? HORSES[humanHorseIdx].emoji : '­ƒÉÄ';

      await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('launching', {
        humans: [userId], aiCount: formula.aiCount, pot: totalPool, horsesSnapshot,
      }));

      let starter = null;
      let thread = null;
      try {
        const made = await createRaceThread(channel, 'course-ia');
        starter = made.starter;
        thread = made.thread;
        await updateRaceWatchMessage(channel, thread, '­ƒöù Regarder la course');

        await safeSend(thread, {
          embeds: [new EmbedBuilder()
            .setTitle('­ƒÅç Course contre l\'IA')
            .setDescription(`Humain : ${humanHorseEmoji} <@${userId}> avec **${humanHorseName}**\nFormule : ${formula.label}\nIA adverses : ${formula.aiCount}\nGain final : ${totalPool.toLocaleString('fr-FR')} kamas`)
            .setColor(0x3498DB)
            .setImage(RACE_BANNER_URL)
            .setTimestamp(utcnow())]
        });

        await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('running', {
          humans: [userId], aiCount: formula.aiCount, pot: totalPool, horsesSnapshot,
        }));

        await sendRoleNotification(channel, getIaStartRoleNotification(userId, formula.label, formula.prize), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);

        const participantsSnapshot = [userId];
        const humanHorse = playerHorses[userId];
        const usedHorses = new Set([humanHorse]);
        const available = [0, 1, 2, 3].filter((i) => !usedHorses.has(i));
        const contestants = [['human', userId, humanHorse]];
        for (let i = 0; i < formula.aiCount; i++) {
          const horse = available.length ? available.shift() : Math.floor(Math.random() * 4);
          contestants.push(['ai', null, horse]);
          usedHorses.add(horse);
        }
        contestants.sort(() => Math.random() - 0.5);

        const [winnerType, winnerId, winnerHorseIdx, winnerName] = await runRaceWithRandomBonus(thread, contestants, { jackpotBias: !!formula.jackpotBias });

        if (winnerType === 'human') {
          const totalPayout = totalPool;
          const text = getHumanVictoryEmbedText(HORSES[winnerHorseIdx].emoji, winnerName, winnerId, totalPayout, { formulaLabel: formula.label });
          await safeSend(thread, {
            embeds: [new EmbedBuilder()
              .setTitle(text.title)
              .setDescription(text.description)
              .setColor(0x2ECC71)
              .setImage(RESULT_IMAGE_URL)
              .setTimestamp(utcnow())]
          });
          await safeSend(thread, { content: `­ƒÅå <@${winnerId}>, tu remportes **${totalPayout.toLocaleString('fr-FR')} kamas** au total avec la formule **${formula.label}**. Contacte **Tonymerguez** en message priv├® pour r├®cup├®rer tes gains.` });
          await createPayoutRecord(winnerId, winnerHorseIdx, totalPool, 0, totalPayout, participantsSnapshot, winnerName);
          await logRaceResult(participantsSnapshot, horsesSnapshot, winnerId, winnerName, totalPayout);
          await updateStatsAfterRace(participantsSnapshot, winnerId, winnerName, totalPool);
          await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('finished', { humans: [userId], aiCount: formula.aiCount, pot: totalPool, winnerId, winnerName, horsesSnapshot }));
          await sendRoleNotification(channel, getHumanVictoryRoleNotification(winnerId, winnerName), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);
        } else {
          const text = getAiVictoryEmbedText(HORSES[winnerHorseIdx].emoji, winnerName, totalPool, { formulaLabel: formula.label });
          await safeSend(thread, {
            embeds: [new EmbedBuilder()
              .setTitle(text.title)
              .setDescription(text.description)
              .setColor(0xE67E22)
              .setImage(RESULT_IMAGE_URL)
              .setTimestamp(utcnow())]
          });
          await logRaceResult(participantsSnapshot, horsesSnapshot, 0, winnerName, totalPool);
          await updateStatsAfterRace(participantsSnapshot, 0, winnerName, 0);
          await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('finished', { humans: [userId], aiCount: formula.aiCount, pot: 0, winnerId: 0, winnerName, horsesSnapshot }));
          await sendRoleNotification(channel, getAiVictoryRoleNotification(winnerName), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);
        }

        await safeSend(thread, { content: `­ƒùæ´©Å Ce thread sera supprim├® dans ${THREAD_LIFETIME} secondes.` });
        await new Promise((r) => setTimeout(r, THREAD_LIFETIME * 1000));
      } catch (error) {
        logException('startIaRace.inner', error);
        try { await safeSend(channel, { content: 'ÔØî Impossible de lancer la course IA. Consulte les logs du bot.' }); } catch {}
      } finally {
        if (thread) {
          try { await thread.delete(); } catch {}
        }
        if (starter) {
          setTimeout(() => safeDeleteMessage(starter), THREAD_LIFETIME * 1000);
        }
        await finishRace(channel);
      }
    } catch (error) {
      logException('startIaRace.delayedLaunch', error);
      clearIaPendingLaunch();
      await finishRace(channel);
    }
  }, IA_PRESTART_SECONDS * 1000);
}

async function startPlayersWait(userId, channel, nbAdversaires) {
  clearIaPendingLaunch();
  if (raceInProgress || waitingForPlayers) return;

  waitingForPlayers = true;
  raceInProgress = false;
  expectedHumans = 1 + nbAdversaires;
  matchmakingStartedAt = Date.now();
  fullLobbyDeadlineAt = 0;
  matchLaunchInProgress = false;
  currentMatchCreatorId = userId;
  currentMatchSessionId = newMatchSessionId();
  const sessionId = currentMatchSessionId;

  stopMatchmakingTimers();
  await updateMainMessage(channel);
  await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('waiting', {
    creatorId: userId,
    humans: [...currentPlayers],
    pot: REAL_BET * currentPlayers.length,
    horsesSnapshot: { ...playerHorses },
  }));

  await sendRoleNotification(channel, getSearchRoleNotification(userId, nbAdversaires));

  waitTask = setInterval(async () => {
    try {
      if (!waitingForPlayers || currentMatchSessionId !== sessionId) return;
      if (!currentPlayers.length) {
        await cancelMatchmakingSession(channel, 'La file dÔÇÖattente a ├®t├® annul├®e, tous les joueurs se sont retir├®s.');
        return;
      }
      if (currentMatchCreatorId && !currentPlayers.includes(currentMatchCreatorId)) {
        await cancelMatchmakingSession(channel, 'Le cr├®ateur du pari a annul├® sa participation, la file est donc ferm├®e.');
        return;
      }

      if (currentPlayers.length >= expectedHumans) {
        if (!fullLobbyDeadlineAt) fullLobbyDeadlineAt = Date.now() + FULL_LOBBY_START_DELAY_SECONDS * 1000;
      } else {
        fullLobbyDeadlineAt = 0;
      }

      await updateWaitingMessage();
      await updateMainMessage(channel);

      if (fullLobbyDeadlineAt && Date.now() >= fullLobbyDeadlineAt) {
        stopMatchmakingTimers();
        await waitForPlayers(channel, sessionId);
      }
    } catch (error) {
      logException('startPlayersWait.interval', error);
    }
  }, 2000);

  waitTimeoutTask = setTimeout(async () => {
    try {
      if (!waitingForPlayers || currentMatchSessionId !== sessionId) return;
      stopMatchmakingTimers();
      await waitForPlayers(channel, sessionId);
    } catch (error) {
      logException('startPlayersWait.timeout', error);
    }
  }, WAIT_TIME * 1000);
}

async function waitForPlayers(channel, sessionId = null) {
  if (sessionId && currentMatchSessionId !== sessionId) return;
  if (matchLaunchInProgress) return;
  matchLaunchInProgress = true;

  let starter = null;
  let thread = null;
  try {
    if (!currentPlayers.length) {
      await cancelMatchmakingSession(channel, 'La recherche dÔÇÖadversaires a ├®t├® annul├®e car tous les joueurs ont quitt├® la file.');
      return;
    }
    if (!currentMatchCreatorId || !currentPlayers.includes(currentMatchCreatorId)) {
      await cancelMatchmakingSession(channel, 'Le cr├®ateur nÔÇÖest plus pr├®sent, la file est ferm├®e.');
      return;
    }

    waitingForPlayers = false;
    raceInProgress = true;
    await updateMainMessage(channel);

    const humans = currentPlayers.slice(0, expectedHumans);
    const nbHumans = humans.length;
    const nbIaNeeded = expectedHumans - nbHumans;
    const totalPool = REAL_BET * nbHumans;
    const participantsSnapshot = [...humans];
    const horsesSnapshot = Object.fromEntries(participantsSnapshot.map((uid) => [uid, playerHorses[uid]]));

    const usedHorses = new Set();
    const contestants = [];
    for (const uid of humans) {
      const horse = playerHorses[uid];
      contestants.push(['human', uid, horse]);
      usedHorses.add(horse);
    }
    const available = [0, 1, 2, 3].filter((i) => !usedHorses.has(i));
    for (let i = 0; i < nbIaNeeded; i++) {
      const horse = available.length ? available.shift() : Math.floor(Math.random() * 4);
      contestants.push(['ai', null, horse]);
      usedHorses.add(horse);
    }
    contestants.sort(() => Math.random() - 0.5);

    await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('launching', {
      humans, aiCount: nbIaNeeded, pot: totalPool, horsesSnapshot,
    }));

    const made = await createRaceThread(channel, 'course-joueurs');
    starter = made.starter;
    thread = made.thread;
    await updateRaceWatchMessage(channel, thread, '­ƒöù Regarder la course');

    await safeSend(thread, {
      embeds: [new EmbedBuilder()
        .setTitle('­ƒÅç Course entre joueurs')
        .setDescription(`Participants :\n${humanHorseLines(humans, horsesSnapshot)}\nIA compl├®mentaires : ${nbIaNeeded}\nCagnotte : ${totalPool.toLocaleString('fr-FR')} kamas`)
        .setColor(0x3498DB)
        .setImage(RACE_BANNER_URL)
        .setTimestamp(utcnow())],
    });

    await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('running', {
      humans, aiCount: nbIaNeeded, pot: totalPool, horsesSnapshot,
    }));

    await sendRoleNotification(channel, getPlayersStartRoleNotification(humans), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);

    const [winnerType, winnerId, winnerHorseIdx, winnerName] = await runRaceWithRandomBonus(thread, contestants);

    if (winnerType === 'human') {
      const totalPayout = totalPool;
      const text = getHumanVictoryEmbedText(HORSES[winnerHorseIdx].emoji, winnerName, winnerId, totalPool);
      await safeSend(thread, {
        embeds: [new EmbedBuilder()
          .setTitle(text.title)
          .setDescription(text.description)
          .setColor(0x2ECC71)
          .setImage(RESULT_IMAGE_URL)
          .setTimestamp(utcnow())]
      });
      await safeSend(thread, { content: `­ƒÅå <@${winnerId}>, tu remportes **${totalPool.toLocaleString('fr-FR')} kamas**. Cela comprend ta mise jou├®e et celles de tes adversaires humains. Contacte **Tonymerguez** en message priv├® pour r├®cup├®rer tes gains.` });
      await createPayoutRecord(winnerId, winnerHorseIdx, totalPool, 0, totalPayout, participantsSnapshot, winnerName);
      await logRaceResult(participantsSnapshot, horsesSnapshot, winnerId, winnerName, totalPayout);
      await updateStatsAfterRace(participantsSnapshot, winnerId, winnerName, totalPool);
      await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('finished', {
        humans, aiCount: nbIaNeeded, pot: totalPool, winnerId, winnerName, horsesSnapshot,
      }));
      await sendRoleNotification(channel, getHumanVictoryRoleNotification(winnerId, winnerName), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);
    } else {
      const text = getAiVictoryEmbedText(HORSES[winnerHorseIdx].emoji, winnerName, totalPool);
      await safeSend(thread, {
        embeds: [new EmbedBuilder()
          .setTitle(text.title)
          .setDescription(text.description)
          .setColor(0xE67E22)
          .setImage(RESULT_IMAGE_URL)
          .setTimestamp(utcnow())]
      });
      await logRaceResult(participantsSnapshot, horsesSnapshot, 0, winnerName, totalPool);
      await updateStatsAfterRace(participantsSnapshot, 0, winnerName, 0);
      await upsertRaceAnnouncement(channel, buildRaceStatusEmbed('finished', {
        humans, aiCount: nbIaNeeded, pot: 0, winnerId: 0, winnerName, horsesSnapshot,
      }));
      await sendRoleNotification(channel, getAiVictoryRoleNotification(winnerName), [], ROLE_NOTIFICATION_DELETE_AFTER_SECONDS, false);
    }

    await safeSend(thread, { content: `­ƒùæ´©Å Ce thread sera supprim├® dans ${THREAD_LIFETIME} secondes.` });
    await new Promise((r) => setTimeout(r, THREAD_LIFETIME * 1000));
  } catch (error) {
    logException('waitForPlayers', error);
    try { await safeSend(channel, { content: 'ÔØî Erreur pendant la course joueurs. Consulte les logs du bot.' }); } catch {}
  } finally {
    if (thread) {
      try { await thread.delete(); } catch {}
    }
    if (starter) setTimeout(() => safeDeleteMessage(starter), THREAD_LIFETIME * 1000);
    currentMatchSessionId = null;
    matchLaunchInProgress = false;
    await finishRace(channel);
  }
}

async function cancelMatchmakingSession(channel, reason = null) {
  const usersToCancel = [...currentPlayers];

  for (const uid of usersToCancel) {
    try {
      await cancelUserParticipationDebt(uid);
    } catch (error) {
      logException(`cancelMatchmakingSession.cancelUserParticipationDebt.${uid}`, error);
    }
  }

  waitingForPlayers = false;
  raceInProgress = false;
  expectedHumans = 0;
  currentMatchCreatorId = null;
  currentMatchSessionId = null;
  stopMatchmakingTimers();
  resetPlayersState();
  clearReservation();
  clearIaPendingLaunch();
  clearRaceWatchMessage();

  if (raceAnnouncementMsg) {
    try {
      if (reason) {
        await safeEditMessage(raceAnnouncementMsg, { content: null, embeds: [buildRaceStatusEmbed('cancelled', { reason })], components: [] });
      }
    } catch {}
    await safeDeleteMessage(raceAnnouncementMsg);
    raceAnnouncementMsg = null;
  }

  if (channel) await updateMainMessage(channel).catch(() => {});
}

const slashCommands = [
  new SlashCommandBuilder().setName('dragodinde_setup').setDescription('Configure le jeu et cr├®e l\'annonce ├®pingl├®e'),
  new SlashCommandBuilder().setName('dragodinde_config').setDescription('Modifier la configuration dragodinde'),
  new SlashCommandBuilder().setName('set_emojis_dragodinde').setDescription('D├®finir les 4 emojis des dragodindes')
    .addStringOption((o) => o.setName('emoji1').setDescription('Tonnerre').setRequired(true))
    .addStringOption((o) => o.setName('emoji2').setDescription('Éclair').setRequired(true))
    .addStringOption((o) => o.setName('emoji3').setDescription('Foudre').setRequired(true))
    .addStringOption((o) => o.setName('emoji4').setDescription('Tempête').setRequired(true)),
  new SlashCommandBuilder().setName('setup_dashboard_dragodinde').setDescription('Cr├®e ou met ├á jour le tableau de bord dragodinde')
    .addChannelOption((o) => o.setName('salon').setDescription('Salon du dashboard').setRequired(true).addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('debt_report_dragodinde').setDescription('Rapport d├®taill├® des dettes dragodinde'),
  new SlashCommandBuilder().setName('reset_total_dragodinde').setDescription('Supprime les messages du jeu et remet tout ├á z├®ro'),
  new SlashCommandBuilder().setName('ping_dragodinde').setDescription('V├®rifier la latence du module dragodinde'),
].map((c) => c.toJSON());

function buildCommands() {
  return slashCommands;
}

function isAdminMember(member) {
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

async function maybeApplyDraftConfig(interaction, draft) {
  if (!draft.logs_channel_id) return false;

  config.logs_channel_id = draft.logs_channel_id;
  config.dashboard_channel_id = draft.dashboard_channel_id || null;
  config.admin_role_id = draft.admin_role_id || null;
  config.allowed_role_ids = draft.allowed_role_ids || [];
  config.notification_role_id = config.allowed_role_ids[0] || null;

  if (!config.main_channel_id || interaction.channelId !== config.main_channel_id) {
    config.main_channel_id = interaction.channelId || null;
    config.main_message_id = null;
    MAIN_CHANNEL_ID = config.main_channel_id;
    MAIN_MESSAGE_ID = null;
    mainMessage = null;
  }

  if (!draft.dashboard_channel_id || draft.dashboard_channel_id !== config.dashboard_channel_id) {
    config.dashboard_message_id = null;
    DASHBOARD_MESSAGE_ID = null;
  }

  saveConfig();

  LOGS_CHANNEL_ID = config.logs_channel_id;
  DASHBOARD_CHANNEL_ID = config.dashboard_channel_id;
  ADMIN_ROLE_ID = config.admin_role_id;
  NOTIF_ROLE_ID = config.notification_role_id;
  ALLOWED_ROLE_IDS = config.allowed_role_ids;

  if (interaction.channel) await updateMainMessage(interaction.channel).catch(() => {});
  await updateDashboard().catch(() => {});
  configDrafts.delete(interaction.user.id);
  setupInProgressByUser.delete(interaction.user.id);
  return true;
}

async function handleConfigSelect(interaction) {
  const draft = getConfigDraft(interaction.user.id);

  if (interaction.customId === 'config:logs_channel') {
    draft.logs_channel_id = interaction.values[0] || null;
    await interaction.reply({ content: `Salon des logs s├®lectionn├® : <#${interaction.values[0]}>`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.customId === 'config:dashboard_channel') {
    draft.dashboard_channel_id = interaction.values[0] || null;
    await interaction.reply({ content: `Salon du dashboard s├®lectionn├® : <#${interaction.values[0]}>`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.customId === 'config:admin_role') {
    draft.admin_role_id = interaction.values[0] || null;
    await interaction.reply({ content: `R├┤le admin : ${draft.admin_role_id ? `<@&${draft.admin_role_id}>` : 'Aucun'}`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.customId === 'config:allowed_roles') {
    draft.allowed_role_ids = [...interaction.values];
    draft.notification_role_id = draft.allowed_role_ids[0] || null;
    const txt = draft.allowed_role_ids.length ? draft.allowed_role_ids.map((rid) => `<@&${rid}>`).join(', ') : 'Aucun filtre de r├┤le';
    await interaction.reply({ content: `R├┤le autoris├® et notification : ${txt}`, flags: MessageFlags.Ephemeral });
    return true;
  }
  return false;
}

async function showChannelSearchModal(interaction, type) {
  const label = type === 'logs' ? 'logs' : 'dashboard';
  const modal = new ModalBuilder()
    .setCustomId(`config:searchmodal:${label}`)
    .setTitle(`Recherche salon ${label}`);

  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Nom du salon à rechercher')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(type === 'logs' ? 'ex: logs, gains, pmu...' : 'ex: dashboard, course, suivi...');

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
  return true;
}

async function handleChannelSearchModal(interaction) {
  const [, , type] = interaction.customId.split(':');
  const draft = getConfigDraft(interaction.user.id);
  const query = String(interaction.fields.getTextInputValue('query') || '').trim().toLowerCase();
  if (!query) {
    await interaction.reply({ content: 'Recherche vide.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const channels = getSelectableTextChannels(interaction.guild)
    .filter((ch) => ch.name.toLowerCase().includes(query))
    .slice(0, 10);

  if (!channels.length) {
    await interaction.reply({ content: `Aucun salon trouvé pour **${query}**.`, flags: MessageFlags.Ephemeral });
    return true;
  }

  const selected = channels[0];
  if (type == 'logs') draft.logs_channel_id = selected.id;
  if (type == 'dashboard') draft.dashboard_channel_id = selected.id;

  const others = channels.slice(1).map((ch) => `• <#${ch.id}>`).join('\n');
  await interaction.reply({
    content: `${type == 'logs' ? 'Salon des logs' : 'Salon du dashboard'} sélectionné automatiquement : <#${selected.id}>` + (others ? `\nAutres correspondances :\n${others}` : ''),
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleButtonInteraction(interaction) {
  const { customId } = interaction;

  if (customId === 'config:search:logs') return showChannelSearchModal(interaction, 'logs');
  if (customId === 'config:search:dashboard') return showChannelSearchModal(interaction, 'dashboard');

  if (customId === 'config:validate') {
    if (!setupInProgressByUser.has(interaction.user.id)) {
      return interaction.reply({ content: 'Aucune configuration en cours ├á valider.', flags: MessageFlags.Ephemeral });
    }
    const draft = getConfigDraft(interaction.user.id);
    if (!draft.logs_channel_id) {
      return interaction.reply({ content: 'Tu dois au minimum choisir le salon des logs avant de valider.', flags: MessageFlags.Ephemeral });
    }

    const applied = await maybeApplyDraftConfig(interaction, draft);
    if (!applied) {
      return interaction.reply({ content: 'Impossible dÔÇÖappliquer la configuration.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({ content: 'Configuration Dragodinde valid├®e et appliqu├®e.', flags: MessageFlags.Ephemeral });
  }

  if (customId === 'config:cancel') {
    configDrafts.delete(interaction.user.id);
    setupInProgressByUser.delete(interaction.user.id);
    return interaction.reply({ content: 'Configuration brouillon annul├®e.', flags: MessageFlags.Ephemeral });
  }

  if (customId === 'join:main') {
    const [allowed, reason] = canUserPlay(interaction.member);
    if (!allowed) return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    if (cooldown) return interaction.reply({ content: 'Une course vient de se terminer, patiente quelques secondes.', flags: MessageFlags.Ephemeral });
    if (raceInProgress || iaPendingLaunch) return interaction.reply({ content: 'Une course est d├®j├á en cours ou en pr├®paration, reviens dans un instant.', flags: MessageFlags.Ephemeral });
    if (currentPlayers.includes(interaction.user.id)) return interaction.reply({ content: 'Tu es d├®j├á inscrit pour cette course.', flags: MessageFlags.Ephemeral });

    if (waitingForPlayers) {
      if (currentPlayers.length >= expectedHumans) return interaction.reply({ content: 'Toutes les places sont d├®j├á prises.', flags: MessageFlags.Ephemeral });
      if (isJoinWindowLocked()) return interaction.reply({ content: 'Les inscriptions sont ferm├®es durant les 30 derni├¿res secondes avant le d├®part.', flags: MessageFlags.Ephemeral });
      return interaction.reply({
        content: 'Choisis ta dragodinde pour rejoindre la course en attente :',
        components: horseChoiceRows(interaction.user.id, 'join_waiting', 'players', null),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (reservationIsActive() && currentReservation.user_id !== interaction.user.id) {
      const remaining = Math.max(0, Math.floor((currentReservation.expires_at - Date.now()) / 1000));
      return interaction.reply({ content: `Une autre personne est en train de finaliser son inscription.\nPriorit├® ├á <@${currentReservation.user_id}> pendant encore **${remaining} sec**.`, flags: MessageFlags.Ephemeral });
    }

    const token = createReservation(interaction.user.id);
    await updateMainMessage(interaction.channel);
    return interaction.reply({ content: 'Choisis ton mode de jeu :', components: modeChoiceRows(interaction.user.id, token), flags: MessageFlags.Ephemeral });
  }

  if (customId.startsWith('mode:')) {
    const [, mode, userId, token] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });

    await interaction.update({ content: `Mode choisi : ${mode === 'ia' ? "Contre l'IA" : "Contre d'autres joueurs"}`, components: [] });
    autoDeleteInteractionReply(interaction, 4000);
    const follow = await interaction.followUp({
      content: mode === 'ia'
        ? 'Choisis ta formule IA : ­ƒÆ░ Double ta mise, ­ƒÆÄ Triple ta mise, ou ­ƒææ Jackpot 2M'
        : 'Combien d\'adversaires humains veux-tu ? (1, 2 ou 3)',
      components: countChoiceRows(userId, token, mode),
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    autoDeleteFollowUp(interaction, follow, 15000);
    return true;
  }

  if (customId.startsWith('count:')) {
    const parts = customId.split(':');
    const selectedMode = parts[1];

    if (selectedMode === 'ia') {
      const [, , stakeCode, prizeCode, userId, token] = parts;
      if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
      if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });

      const iaFormula = parseIaFormula(`${stakeCode}|${prizeCode}`);
      if (!iaFormula) return interaction.reply({ content: 'Formule IA invalide.', flags: MessageFlags.Ephemeral });

      if (`${stakeCode}|${prizeCode}` === '220k|2000k') {
        await interaction.update({
          content: `­ƒææ **LE GROS COUP DU PMU** ­ƒææ\n\nTu es ├á deux doigts de tenter le pari que les gens racontent encore au comptoir quand ├ºa tourne bien... ou quand ├ºa finit tr├¿s mal.\n\n­ƒÆ░ **Mise demand├®e : 220 000 kamas**\n­ƒÅå **Gain potentiel : 2 000 000 kamas**\n­ƒñû **Adversaires : 3 IA**\nÔÅ│ **Temps pour d├®cider : ${JACKPOT_CONFIRM_WINDOW_SECONDS} secondes**\n\nSi tu valides, tu entres dans la cat├®gorie des gens tr├¿s confiants, ou tr├¿s mal conseill├®s.\n\nConfirme que tu veux bien engager cette mise avant de choisir ta dragodinde.`,
          components: iaJackpotConfirmRows(userId, token)
        });
        setTimeout(async () => {
          try {
            if (!reservationOwnedBy(userId, token)) return;
            await interaction.editReply({
              content: 'ÔÅ│ Temps ├®coul├®. La demande de course jackpot a ├®t├® annul├®e, il faudra recommencer.',
              components: []
            }).catch(() => {});
            clearReservation();
            if (mainMessage) await updateMainMessage(interaction.channel).catch(() => {});
          } catch {}
        }, JACKPOT_CONFIRM_WINDOW_SECONDS * 1000);
        return true;
      }

      await interaction.update({ content: `Formule choisie : ${iaFormula.label} , gain potentiel **${iaFormula.prize.toLocaleString('fr-FR')} kamas**`, components: [] });
      autoDeleteInteractionReply(interaction, 4000);
      const follow = await interaction.followUp({
        content: 'Choisis maintenant ta dragodinde :',
        components: horseChoiceRows(userId, 'new_match', selectedMode, `${stakeCode}|${prizeCode}`, token),
        flags: MessageFlags.Ephemeral,
        withResponse: true
      });
      autoDeleteFollowUp(interaction, follow, 15000);
      return true;
    }

    const [, , count, userId, token] = parts;
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });

    await interaction.update({ content: `Nombre choisi : ${count}`, components: [] });
    autoDeleteInteractionReply(interaction, 4000);
    const follow = await interaction.followUp({
      content: 'Choisis maintenant ta dragodinde :',
      components: horseChoiceRows(userId, 'new_match', selectedMode, count, token),
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    autoDeleteFollowUp(interaction, follow, 15000);
    return true;
  }

  if (customId.startsWith('iaconfirm:')) {
    const [, stakeCode, prizeCode, userId, token] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });

    await interaction.update({ content: 'Confirmation prise en compte.', components: [] });
    autoDeleteInteractionReply(interaction, 4000);
    const follow = await interaction.followUp({
      content: 'Choisis maintenant ta dragodinde :',
      components: horseChoiceRows(userId, 'new_match', 'ia', `${stakeCode}|${prizeCode}`, token),
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    autoDeleteFollowUp(interaction, follow, 15000);
    return true;
  }

  if (customId.startsWith('iaback:')) {
    const [, userId, token] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });

    await interaction.update({
      content: 'Choisis ta formule IA : ­ƒÆ░ Double ta mise, ­ƒÆÄ Triple ta mise, ou ­ƒææ Jackpot 2M',
      components: countChoiceRows(userId, token, 'ia')
    });
    return true;
  }

  if (customId.startsWith('horse:')) {
    const [, contextMode, selectedMode, selectedCountRaw, horseIndexRaw, userId, token] = customId.split(':');
    const selectedCount = selectedCountRaw === 'null' ? null : Number(selectedCountRaw);
    const horseIndex = Number(horseIndexRaw);

    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    const [allowed, reason] = canUserPlay(interaction.member);
    if (!allowed) return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });

    if (contextMode === 'new_match') {
      if (!reservationOwnedBy(userId, token)) return interaction.reply({ content: 'Cette tentative a expiré. Recommence en cliquant sur Participer.', flags: MessageFlags.Ephemeral });
      if (!canJoinButtonBeEnabled() && !waitingForPlayers) return interaction.reply({ content: 'Le jeu n\'est pas disponible pour le moment.', flags: MessageFlags.Ephemeral });
    }

    if (currentPlayers.includes(interaction.user.id)) return interaction.reply({ content: 'Tu es d├®j├á inscrit.', flags: MessageFlags.Ephemeral });

    if (contextMode === 'join_waiting') {
      const takenHorses = new Set(currentPlayers.map((uid) => playerHorses[uid]).filter((v) => v !== undefined));
      if (takenHorses.has(horseIndex)) return interaction.reply({ content: 'Cette dragodinde est d├®j├á prise par un autre joueur. Choisis-en une autre.', flags: MessageFlags.Ephemeral });
    }

    await interaction.update({ content: `Dragodinde choisie : ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}`, components: [] });
    autoDeleteInteractionReply(interaction, 4000);

    let debtAmount = ENTRY_FEE;
    let debtMeta = { mode: selectedMode };
    let iaFormula = null;

    if (selectedMode === 'ia') {
      iaFormula = parseIaFormula(selectedCountRaw);
      if (!iaFormula) return interaction.followUp({ content: 'Formule IA invalide.', flags: MessageFlags.Ephemeral });
      debtAmount = iaFormula.stake;
      debtMeta = { mode: selectedMode, formula_label: iaFormula.label };
    }

    const recordId = await createDebtRecord(userId, horseIndex, debtAmount, debtMeta);
    if (!recordId) return interaction.followUp({ content: 'Impossible de cr├®er l\'engagement de paiement. V├®rifie le salon des logs.', flags: MessageFlags.Ephemeral });

    currentPlayers.push(userId);
    playerHorses[userId] = horseIndex;
    playerMode[userId] = { type: selectedMode, count: selectedCount, debt_record_id: recordId, ia_formula: iaFormula };

    const debtMsg = await interaction.followUp({
      content: selectedMode === 'ia' && iaFormula
        ? `Participation valid├®e pour **${iaFormula.label}**. Gain potentiel : **${iaFormula.prize.toLocaleString('fr-FR')} kamas**.`
        : 'Participation valid├®e.',
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    autoDeleteFollowUp(interaction, debtMsg, 6000);

    if (contextMode === 'join_waiting') {
      const msg = await interaction.followUp({
        content: `Tu as rejoint la course en attente avec ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}. Annulation possible pendant ${MATCH_CANCEL_WINDOW_SECONDS} secondes.`,
        components: cancelParticipationRows(userId),
        flags: MessageFlags.Ephemeral,
        withResponse: true
      });
      autoDeleteFollowUp(interaction, msg, MATCH_CANCEL_WINDOW_SECONDS * 1000);
      await updateMainMessage(interaction.channel).catch(() => {});
      await updateWaitingMessage().catch(() => {});
      return true;
    }

    clearReservation();
    const confirm = await interaction.followUp({
      content: `Inscription valid├®e ! Cheval : ${HORSES[horseIndex].emoji} ${HORSES[horseIndex].name}`,
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    autoDeleteFollowUp(interaction, confirm, 6000);

    if (selectedMode === 'ia') {
      const msg = await interaction.followUp({
        content:
          `D├®part contre l'IA dans **${IA_PRESTART_SECONDS} secondes**.\n` +
          `Tu peux annuler pendant **${IA_CANCEL_WINDOW_SECONDS} secondes**.`,
        components: cancelIaLaunchRows(userId),
        flags: MessageFlags.Ephemeral,
        withResponse: true
      });
      autoDeleteFollowUp(interaction, msg, IA_CANCEL_WINDOW_SECONDS * 1000);
      await updateMainMessage(interaction.channel).catch(() => {});
      await startIaRace(userId, interaction.channel, iaFormula);
    } else {
      currentMatchCreatorId = userId;
      const msg = await interaction.followUp({
        content: `Recherche d'adversaires lanc├®e. Tu peux annuler pendant **${MATCH_CANCEL_WINDOW_SECONDS} secondes**.`,
        components: cancelParticipationRows(userId),
        flags: MessageFlags.Ephemeral,
        withResponse: true
      });
      autoDeleteFollowUp(interaction, msg, MATCH_CANCEL_WINDOW_SECONDS * 1000);
      await updateMainMessage(interaction.channel).catch(() => {});
      await startPlayersWait(userId, interaction.channel, selectedCount);
    }
    return true;
  }

  if (customId.startsWith('cancelia:')) {
    const [, userId] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (!iaPendingLaunch || iaPendingUserId !== userId) return interaction.reply({ content: 'Il nÔÇÖy a plus de d├®part IA en attente pour toi.', flags: MessageFlags.Ephemeral });

    await cancelUserParticipationDebt(userId).catch((error) => logException('cancelia.cancelUserParticipationDebt', error));

    clearIaPendingLaunch();
    currentPlayers = currentPlayers.filter((uid) => uid !== userId);
    delete playerHorses[userId];
    delete playerMode[userId];
    clearReservation();

    await interaction.update({ content: 'La course contre lÔÇÖIA a ├®t├® annul├®e avant le d├®part.', components: [] });
    autoDeleteInteractionReply(interaction, 5000);
    await updateMainMessage(interaction.channel).catch(() => {});
    return true;
  }

  if (customId.startsWith('cancel:')) {
    const [, userId] = customId.split(':');
    if (interaction.user.id !== userId) return interaction.reply({ content: 'Pas autoris├®.', flags: MessageFlags.Ephemeral });
    if (raceInProgress) return interaction.reply({ content: 'La course a d├®j├á commenc├®, tu ne peux plus annuler.', flags: MessageFlags.Ephemeral });
    if (!waitingForPlayers) return interaction.reply({ content: 'Il n\'y a plus de phase d\'attente en cours.', flags: MessageFlags.Ephemeral });
    if (!currentPlayers.includes(userId)) return interaction.reply({ content: 'Tu n\'es plus inscrit ├á cette course.', flags: MessageFlags.Ephemeral });
    if (!canCancelParticipationNow()) return interaction.reply({ content: `Le d├®sistement nÔÇÖest autoris├® que pendant les ${MATCH_CANCEL_WINDOW_SECONDS} premi├¿res secondes de recherche.`, flags: MessageFlags.Ephemeral });

    const isCreator = currentMatchCreatorId === userId;

    await cancelUserParticipationDebt(userId).catch((error) => logException('cancel.cancelUserParticipationDebt', error));

    currentPlayers = currentPlayers.filter((uid) => uid !== userId);
    delete playerHorses[userId];
    delete playerMode[userId];

    await interaction.update({ content: 'Ta participation a ├®t├® annul├®e et ta dette a ├®t├® retir├®e.', components: [] });
    autoDeleteInteractionReply(interaction, 5000);

    if (isCreator) {
      await cancelMatchmakingSession(interaction.channel, 'Le cr├®ateur du pari a annul├® sa participation, la file est donc ferm├®e.');
      return true;
    }
    if (!currentPlayers.length) {
      await cancelMatchmakingSession(interaction.channel, 'La file dÔÇÖattente a ├®t├® annul├®e, tous les joueurs se sont retir├®s.');
      return true;
    }

    await updateMainMessage(interaction.channel).catch(() => {});
    await updateWaitingMessage().catch(() => {});
    return true;
  }

  if (customId.startsWith('payoutpay:')) {
    const [, recordId] = customId.split(':');
    const record = payoutRecords[recordId];
    if (!record) return interaction.reply({ content: 'Enregistrement de gain introuvable.', flags: MessageFlags.Ephemeral });

    let allowed = false;
    if (interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) allowed = true;
    else if (ADMIN_ROLE_ID && interaction.member.roles.cache.has(ADMIN_ROLE_ID)) allowed = true;
    if (!allowed) return interaction.reply({ content: 'Rôle admin requis.', flags: MessageFlags.Ephemeral });
    if (record.status === 'paid') return interaction.reply({ content: 'Ce gain est déjà validé.', flags: MessageFlags.Ephemeral });

    record.status = 'paid';
    record.paid_at = nowIso();
    record.paid_by_admin_id = interaction.user.id;
    savePayoutRecords();

    const existingEmbed = interaction.message.embeds?.[0];
    const embed = EmbedBuilder.from(existingEmbed)
      .setColor(0x3498DB)
      .setDescription((existingEmbed?.description || '').replace('ÔÅ│ En attente de remise', 'Ô£à Gain remis'))
      .setFooter({ text: `Gain valid├® par ${interaction.user.displayName} le ${new Date().toLocaleString('fr-FR')}` });
    await interaction.update({ embeds: [embed], components: [] });
    await updateDashboard();
    return true;
  }

  if (customId.startsWith('debtpay:')) {
    const [, recordId] = customId.split(':');
    const record = debtRecords[recordId];
    if (!record) return interaction.reply({ content: 'Enregistrement introuvable.', flags: MessageFlags.Ephemeral });

    let allowed = false;
    if (interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) allowed = true;
    else if (ADMIN_ROLE_ID && interaction.member.roles.cache.has(ADMIN_ROLE_ID)) allowed = true;
    if (!allowed) return interaction.reply({ content: 'Rôle admin requis.', flags: MessageFlags.Ephemeral });
    if (record.status === 'paid') return interaction.reply({ content: 'Ce paiement est déjà validé.', flags: MessageFlags.Ephemeral });
    if (record.status === 'cancelled') return interaction.reply({ content: 'Cet engagement a déjà été annulé.', flags: MessageFlags.Ephemeral });

    record.status = 'paid';
    record.paid_at = nowIso();
    record.paid_by_admin_id = interaction.user.id;
    saveDebtRecords();
    applyUserPayment(record.user_id, record.amount);

    const existingEmbed = interaction.message.embeds?.[0];
    const embed = EmbedBuilder.from(existingEmbed).setColor(0x00FF00).setDescription((existingEmbed?.description || '').replace('ÔÅ│ En attente de paiement', 'Ô£à Pay├®')).setFooter({ text: `Validé par ${interaction.user.displayName} le ${new Date().toLocaleString('fr-FR')}` });
    await interaction.update({ embeds: [embed], components: [] });
    await updateDashboard();
    return true;
  }

  return false;
}

async function onInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      const member = interaction.member;
      const guild = interaction.guild;

      if (interaction.commandName === 'dragodinde_setup') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        setupInProgressByUser.add(interaction.user.id);
        configDrafts.set(interaction.user.id, {
          logs_channel_id: null,
          dashboard_channel_id: null,
          admin_role_id: null,
          notification_role_id: null,
          allowed_role_ids: [],
        });
        return interaction.reply({
          content: '### ­ƒÅç Bienvenue dans la configuration du jeu\nChoisis tous les éléments, puis valide à la fin. Rien ne sera créé avant validation.',
          components: configRows(guild),
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.commandName === 'dragodinde_config') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        setupInProgressByUser.add(interaction.user.id);
        configDrafts.set(interaction.user.id, {
          logs_channel_id: config.logs_channel_id || null,
          dashboard_channel_id: config.dashboard_channel_id || null,
          admin_role_id: config.admin_role_id || null,
          notification_role_id: config.notification_role_id || null,
          allowed_role_ids: [...(config.allowed_role_ids || [])],
        });
        return interaction.reply({ content: 'Modification de la configuration. Rien ne sera appliqué avant validation :', components: configRows(guild), flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'set_emojis_dragodinde') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const emoji1 = interaction.options.getString('emoji1', true).trim();
        const emoji2 = interaction.options.getString('emoji2', true).trim();
        const emoji3 = interaction.options.getString('emoji3', true).trim();
        const emoji4 = interaction.options.getString('emoji4', true).trim();
        const nextEmojis = [emoji1, emoji2, emoji3, emoji4];

        const invalid = nextEmojis.find((value) => !value || value.length > 100);
        if (invalid) {
          return interaction.editReply({ content: 'Un des emojis fournis est invalide.' });
        }

        HORSE_EMOJIS = nextEmojis;
        config.horse_emojis = HORSE_EMOJIS;
        saveConfig();
        refreshHorsesFromEmojis();

        try {
          if (mainMessage) await updateMainMessage(interaction.channel);
          await updateDashboard().catch(() => {});
        } catch (error) {
          logException('set_emojis_dragodinde.refresh', error);
        }

        await interaction.editReply({
          content: `Emojis mis à jour !\nTonnerre: ${HORSE_EMOJIS[0]}\nÉclair: ${HORSE_EMOJIS[1]}\nFoudre: ${HORSE_EMOJIS[2]}\nTempête: ${HORSE_EMOJIS[3]}`
        });
        return true;
      }

      if (interaction.commandName === 'setup_dashboard_dragodinde') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        const salon = interaction.options.getChannel('salon', true);
        config.dashboard_channel_id = salon.id;
        config.dashboard_message_id = null;
        saveConfig();
        DASHBOARD_CHANNEL_ID = salon.id;
        DASHBOARD_MESSAGE_ID = null;
        await interaction.reply({ content: `Salon du dashboard défini sur ${salon}`, flags: MessageFlags.Ephemeral });
        await updateDashboard();
        return true;
      }

      if (interaction.commandName === 'debt_report_dragodinde') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        const debtRows = Object.entries(finance)
          .filter(([, data]) => Number(data?.total_debt || 0) > 0)
          .map(([uid, data]) => [uid, Number(data.total_debt || 0), Number(data.bets_count || 0), Number(data.payments_count || 0)])
          .sort((a, b) => b[1] - a[1]);

        if (!debtRows.length) return interaction.reply({ content: 'Aucune dette en cours.', flags: MessageFlags.Ephemeral });

        const lines = debtRows.slice(0, 25).map(([uid, debt, betsCount, paymentsCount]) =>
          `${debt > DEBT_LIMIT ? '­ƒöÆ bloqu├®' : 'Ô£à autoris├®'} <@${uid}> , **${debt.toLocaleString('fr-FR')} kamas** | paris: ${betsCount} | paiements: ${paymentsCount}`
        );

        const embed = new EmbedBuilder()
          .setTitle('­ƒÆ│ Rapport des dettes')
          .setDescription(lines.join('\n'))
          .setColor(0xE67E22)
          .setTimestamp(utcnow())
          .addFields(
            { name: 'Dette totale', value: `${totalOutstandingDebt().toLocaleString('fr-FR')} kamas`, inline: true },
            { name: 'Joueurs endettés', value: String(indebtedPlayersCount()), inline: true }
          );

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'reset_total_dragodinde') {
        if (!isAdminMember(member)) return interaction.reply({ content: 'Tu dois être administrateur pour utiliser cette commande.', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: 'Reset total en cours...', flags: MessageFlags.Ephemeral });

        stopMatchmakingTimers();
        if (timerTask) clearTimeout(timerTask);
        timerTask = null;
        currentMatchSessionId = null;

        for (const msg of [raceAnnouncementMsg, raceWatchMessage, timerMessage, mainMessage, iaCountdownMessage]) {
          if (msg) await safeDeleteMessage(msg);
        }
        raceAnnouncementMsg = null;
        raceWatchMessage = null;
        timerMessage = null;
        mainMessage = null;
        iaCountdownMessage = null;

        if (iaCountdownIntervalTask) {
          clearInterval(iaCountdownIntervalTask);
          iaCountdownIntervalTask = null;
        }

        if (DASHBOARD_CHANNEL_ID && DASHBOARD_MESSAGE_ID) {
          const dashMsg = await safeFetchMessage(DASHBOARD_CHANNEL_ID, DASHBOARD_MESSAGE_ID);
          if (dashMsg) await safeDeleteMessage(dashMsg);
        }

        for (const rec of Object.values(debtRecords)) {
          const msg = await safeFetchMessage(rec.channel_id, rec.message_id);
          if (msg) await safeDeleteMessage(msg);
        }

        debtRecords = {};
        finance = {};
        payoutRecords = {};
        stats = defaultStats();
        saveDebtRecords();
        saveFinance();
        savePayoutRecords();
        saveStats();

        const previousLogsChannelId = LOGS_CHANNEL_ID;

        config = defaultConfig();
        saveConfig();

        LOGS_CHANNEL_ID = null;
        DASHBOARD_CHANNEL_ID = null;
        DASHBOARD_MESSAGE_ID = null;
        ADMIN_ROLE_ID = null;
        NOTIF_ROLE_ID = null;
        MAIN_CHANNEL_ID = null;
        MAIN_MESSAGE_ID = null;
        ALLOWED_ROLE_IDS = [];

        raceInProgress = false;
        waitingForPlayers = false;
        cooldown = false;
        cooldownEndTime = 0;
        expectedHumans = 0;
        currentMatchCreatorId = null;
        currentMatchSessionId = null;
        resetPlayersState();
        clearReservation();
        clearIaPendingLaunch();

        return interaction.followUp({
          content: `Reset total terminé.\nSalon de logs précédent : ${previousLogsChannelId ? `<#${previousLogsChannelId}>` : 'aucun'}.\nRelance \`/dragodinde_setup\` pour repartir sur une base propre.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (interaction.commandName === 'ping_dragodinde') {
        return interaction.reply({ content: `Pong Dragodinde ! Latence : ${Math.round(client.ws.ping)} ms`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.isModalSubmit()) return handleChannelSearchModal(interaction);
    if (interaction.isStringSelectMenu()) return handleConfigSelect(interaction);
    if (interaction.isButton()) return handleButtonInteraction(interaction);
    return false;
  } catch (error) {
    logException('InteractionCreate', error);
    try {
      if (typeof interaction.isRepliable === 'function' && interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: 'ÔØî Une erreur est survenue.', flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: 'ÔØî Une erreur est survenue.', flags: MessageFlags.Ephemeral });
        }
      } else if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'ÔØî Une erreur est survenue.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'ÔØî Une erreur est survenue.', flags: MessageFlags.Ephemeral });
      }
    } catch {}
    return true;
  }
}

async function onReady(readyClient) {
  client = readyClient;
  logInfo(`Bot connect├® : ${readyClient.user.tag}`);
  refreshHorsesFromEmojis();
  await downloadImage();

  try {
    mainMessage = await safeFetchMessage(MAIN_CHANNEL_ID, MAIN_MESSAGE_ID);
    if (mainMessage) {
      logInfo('[INFO] Message principal restaur├®.');
      await updateMainMessage(mainMessage.channel);
    } else {
      logInfo('[INFO] Aucun message principal restaur├®.');
    }
  } catch (error) {
    logException('restoreMainMessage', error);
  }

  try { await updateDashboard(); } catch (error) { logException('ready.updateDashboard', error); }
}

module.exports = {
  defaultConfig,
  defaultStats,
  loadJson,
  saveJson,
  normalizeDebtRecords,
  normalizeFinance,
  saveConfig,
  saveStats,
  saveDebtRecords,
  saveFinance,
  constants: {
    ENTRY_FEE,
    REAL_BET,
    COMMISSION,
    MAX_PLAYERS,
    WAIT_TIME,
    FULL_LOBBY_START_DELAY_SECONDS,
    CANCEL_JOIN_WINDOW_SECONDS,
    MATCH_CANCEL_WINDOW_SECONDS,
    JOIN_LOCK_LAST_SECONDS,
    COOLDOWN_AFTER_RACE,
    THREAD_LIFETIME,
    DEBT_LIMIT,
    PENDING_RESERVATION_SECONDS,
    IA_CANCEL_WINDOW_SECONDS,
    IA_PRESTART_SECONDS,
    ROLE_NOTIFICATION_DELETE_AFTER_SECONDS,
    TRACK_LENGTH,
    RACE_STEP_MIN,
    RACE_STEP_MAX,
    COMEBACK_TRIGGER_GAP,
    COMEBACK_BONUS_CHANCE,
    LEADER_SLOWDOWN_GAP,
    LEADER_SLOWDOWN_CHANCE,
    AI_SUBTLE_BONUS_CHANCE,
    AI_SUBTLE_MALUS_CHANCE,
    IMAGE_URL,
    RESULT_IMAGE_URL,
    RACE_BANNER_URL,
  },
  state: {
    get config() { return config; },
    get stats() { return stats; },
    get debtRecords() { return debtRecords; },
    get finance() { return finance; },
    get memory() {
      return {
        LOGS_CHANNEL_ID,
        DASHBOARD_CHANNEL_ID,
        DASHBOARD_MESSAGE_ID,
        ADMIN_ROLE_ID,
        NOTIF_ROLE_ID,
        MAIN_CHANNEL_ID,
        MAIN_MESSAGE_ID,
        ALLOWED_ROLE_IDS,
        HORSE_EMOJIS,
        raceInProgress,
        waitingForPlayers,
        cooldown,
        cooldownEndTime,
        currentPlayers,
        playerHorses,
        playerMode,
        matchmakingStartedAt,
        fullLobbyDeadlineAt,
        matchLaunchInProgress,
        expectedHumans,
        currentMatchCreatorId,
        currentMatchSessionId,
        raceAnnouncementMsg,
        raceWatchMessage,
        mainMessage,
        timerMessage,
        waitTask,
        waitTimeoutTask,
        timerTask,
        currentReservation,
        reservationTask,
        iaPendingLaunch,
        iaPendingUserId,
        iaPendingCount,
        iaPendingChannelId,
        iaPendingToken,
        iaStartTask,
        iaStartThreadMessage,
        iaCountdownMessage,
        iaCountdownIntervalTask,
        HORSES,
      };
    },
  },
  setClient(instance) { client = instance; },
  discordRetry,
  safeSend,
  safeEditMessage,
  safeDeleteMessage,
  safeFetchMessage,
  deleteRecentSystemMessages,
  autoDeleteInteractionReply,
  autoDeleteFollowUp,
  refreshHorsesFromEmojis,
  getLogsChannel,
  notifRoleMention,
  notifAllowedMentions,
  pickRandom,
  formatListMentions,
  getSearchRoleNotification,
  getIaStartRoleNotification,
  getPlayersStartRoleNotification,
  getHumanVictoryEmbedText,
  getAiVictoryEmbedText,
  getHumanVictoryRoleNotification,
  getAiVictoryRoleNotification,
  sendRoleNotification,
  getUserFinance,
  getUserDebt,
  addUserDebt,
  applyUserPayment,
  removeUserDebt,
  memberHasAllowedRole,
  canUserPlay,
  totalOutstandingDebt,
  indebtedPlayersCount,
  grossProfit,
  aiWinrate,
  getMatchmakingRemainingSeconds,
  isJoinWindowLocked,
  canCancelParticipationNow,
  canJoinButtonBeEnabled,
  resetPlayersState,
  clearRaceWatchMessage,
  clearIaPendingLaunch,
  stopMatchmakingTimers,
  newMatchSessionId,
  downloadImage,
  cancelDebtRecord,
  cancelUserParticipationDebt,
  reservationIsActive,
  clearReservation,
  createReservation,
  reservationOwnedBy,
  joinButtonRow,
  modeChoiceRows,
  countChoiceRows,
  horseChoiceRows,
  cancelParticipationRows,
  cancelIaLaunchRows,
  channelSelectRow,
  roleSelectRow,
  configRows,
  getConfigDraft,
  getMainMessageContent,
  buildRaceStatusEmbed,
  upsertRaceAnnouncement,
  updateRaceWatchMessage,
  createDebtRecord,
  ensureDashboardMessage,
  logRaceResult,
  updateStatsAfterRace,
  updateDashboard,
  humanHorseLines,
  generateTrack,
  randomRaceEvent,
  getLeaderPosition,
  getSecondPosition,
  computeRaceAdvance,
  runCountdown,
  runRaceWithRandomBonus,
  updateWaitingMessage,
  updateMainMessage,
  updateTimerLoop,
  finishRace,
  createRaceThread,
  startIaRace,
  startPlayersWait,
  waitForPlayers,
  cancelMatchmakingSession,
  buildCommands,
  isAdminMember,
  maybeApplyDraftConfig,
  handleConfigSelect,
  handleButtonInteraction,
  onInteraction,
  onReady,
  logInfo,
  logWarn,
  logError,
  logException,
  utcnow,
  nowIso,
  paths: {
    DATA_DIR,
    CONFIG_FILE,
    DEBTS_FILE,
    FINANCE_FILE,
    STATS_FILE,
    LOG_FILE,
    IMAGE_FILENAME,
  },
};
