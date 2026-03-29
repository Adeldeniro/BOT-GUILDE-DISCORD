const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

// Channels (as requested)
const CHANNEL_DASHBOARD_INSTALL = '1480657603779362961';
const CHANNEL_FICHES_PUBLIC = '1480657603779362966';
const CHANNEL_PING_REQUESTS = '1480657603196616847';

// Roles allowed to ping artisans
const ALLOWED_PING_ROLE_NAMES = ['guildeux', 'invité', 'invite'];

// Paths
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

const JOBS_CATALOG_PATH = path.join(DATA_DIR, 'metiers_catalog.json');
const JOBS_USERS_PATH = path.join(DATA_DIR, 'metiers_users.json');
const JOBS_EMOJIS_PATH = path.join(DATA_DIR, 'metiers_emojis.json');

const DASHBOARD_IMAGE_PATH = path.join(ASSETS_DIR, 'metiers_dashboard.png');
const JOB_ICONS_DIR = path.join(ASSETS_DIR, 'job_icons');

// Cooldown
const PING_COOLDOWN_MS = 2 * 60 * 1000;
const craftPingLast = new Map(); // `${requesterId}:${targetUserId}` -> timestamp

// Search pagination sessions
const jobSearchSessions = new Map(); // searchId -> { requesterId, jobKey, jobLabel, userIds[] }

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function getJobsCatalog() {
  const cat = readJsonSafe(JOBS_CATALOG_PATH, { jobs: [] });
  const jobs = Array.isArray(cat.jobs) ? cat.jobs : [];
  return jobs
    .map((j) => ({
      key: String(j.key || ''),
      label: String(j.label || j.key || ''),
      category: j.category ? String(j.category) : null,
      parent: j.parent ? String(j.parent) : null,
      group: Boolean(j.group),
      image: j.image ? String(j.image) : null,
      href: j.href ? String(j.href) : null,
    }))
    .filter((j) => j.key && j.label);
}

function readEmojisMap() {
  return readJsonSafe(JOBS_EMOJIS_PATH, { version: 1, emojis: {} });
}

function clampInt(n, min, max) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return null;
  return Math.max(min, Math.min(max, x));
}

function normalizeJobName(s) {
  return norm(s)
    .replace(/\s+/g, ' ')
    .replace(/^(le|la|les)\s+/g, '')
    .trim();
}

function newSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

function hasAnyAllowedRole(member) {
  const names = member?.roles?.cache?.map((r) => norm(r.name)) || [];
  return names.some((n) => ALLOWED_PING_ROLE_NAMES.includes(n));
}

async function buildUserJobsEmbed(user, profileJobs) {
  const emojiDb = readEmojisMap();
  const emojiMap = emojiDb.emojis || {};

  const jobs = Array.isArray(profileJobs) ? profileJobs : [];
  const normalJobs = jobs.filter((j) => j.category !== 'forgemagie');
  const fmJobs = jobs.filter((j) => j.category === 'forgemagie');

  const formatLine = (j) => {
    const emoji = emojiMap[j.key] || '';
    return `• ${emoji ? `${emoji} ` : ''}**${j.label}** — niv **${j.level}**`;
  };

  return new EmbedBuilder()
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL({ size: 128 }) })
    .setTitle('🛠️ Fiche métiers')
    .setColor(0x2ecc71)
    .addFields(
      {
        name: 'Métiers',
        value: normalJobs.length
          ? normalJobs.slice().sort((a, b) => (b.level || 0) - (a.level || 0)).map(formatLine).join('\n')
          : '—',
        inline: false,
      },
      {
        name: 'Forgemagie',
        value: fmJobs.length
          ? fmJobs.slice().sort((a, b) => (b.level || 0) - (a.level || 0)).map(formatLine).join('\n')
          : '—',
        inline: false,
      },
    )
    .setFooter({ text: 'LaBaguarre — Annuaire métiers' });
}

function buildDashboardEmbed() {
  return new EmbedBuilder()
    .setTitle('📒 Métiers — Dashboard')
    .setDescription([
      'Gère ta fiche et trouve facilement qui peut craft/FM sur le Discord.',
      '',
      '1) Clique **Gérer mes métiers** pour ajouter/modifier/supprimer',
      '2) Clique **Rechercher** pour trouver les artisans',
    ].join('\n'))
    .setColor(0x5865F2)
    .setImage('attachment://metiers_dashboard.png');
}

function buildDashboardButtons() {
  const manage = new ButtonBuilder()
    .setCustomId('mj:open')
    .setLabel('📒 Gérer mes métiers')
    .setStyle(ButtonStyle.Primary);

  const search = new ButtonBuilder()
    .setCustomId('mj:search')
    .setLabel('🔎 Rechercher')
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder().addComponents(manage, search)];
}

function buildManagePanelButtons(hasJobs) {
  const addBtn = new ButtonBuilder().setCustomId('mj:add').setLabel('➕ Ajouter / modifier').setStyle(ButtonStyle.Primary);
  const delBtn = new ButtonBuilder().setCustomId('mj:del').setLabel('➖ Supprimer').setStyle(ButtonStyle.Secondary).setDisabled(!hasJobs);
  const resetBtn = new ButtonBuilder().setCustomId('mj:reset').setLabel('🗑️ Tout effacer').setStyle(ButtonStyle.Danger).setDisabled(!hasJobs);
  return [new ActionRowBuilder().addComponents(addBtn, delBtn, resetBtn)];
}

module.exports = {
  // constants
  CHANNEL_DASHBOARD_INSTALL,
  CHANNEL_FICHES_PUBLIC,
  CHANNEL_PING_REQUESTS,

  // utils
  getJobsCatalog,
  readJsonSafe,
  writeJsonAtomic,
  readEmojisMap,
  clampInt,
  normalizeJobName,
  newSessionId,
  hasAnyAllowedRole,

  // state
  craftPingLast,
  jobSearchSessions,

  // ui
  buildUserJobsEmbed,
  buildDashboardEmbed,
  buildDashboardButtons,
  buildManagePanelButtons,

  // paths
  JOBS_USERS_PATH,
  JOBS_EMOJIS_PATH,
  JOB_ICONS_DIR,
  DASHBOARD_IMAGE_PATH,
  PING_COOLDOWN_MS,
};
