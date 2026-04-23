const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, Partials, StringSelectMenuBuilder, ChannelType } = require('discord.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const db = require('./db');
const { getConfigForGuild } = require('./runtimeConfig');
const { updateGuildConfig } = require('./guildConfig');
const panel = require('./panel');
const scoreboard = require('./scoreboard');
const profiles = require('./profiles');
const ev = require('./events');
const drafts = require('./eventDrafts');
const stuffGen = require('./stuffGenerator');
const metiers = require('./metiers');

// Stuff generator (DofusBook Touch)
const STUFF_GEN_CHANNEL_ID = '1480657603779362963';
const stuffSessions = new Map(); // sessionId -> { criteria } and per-user shown in `${sessionId}:${userId}`

// DeepL translation (optional)
const deeplThrottle = new Map(); // userId -> lastTs
function deeplEndpointForKey(key) {
  // Free API keys often end with :fx
  return String(key || '').includes(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
}

async function deeplTranslate(text, targetLang) {
  const key = config.deeplApiKey;
  if (!key) throw new Error('Traduction non configurée (clé DeepL manquante).');

  const body = new URLSearchParams();
  body.set('text', text);
  body.set('target_lang', targetLang);

  const resp = await fetch(deeplEndpointForKey(key), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // DeepL legacy auth_key form param has been deprecated (Nov 2025)
      Authorization: `DeepL-Auth-Key ${key}`,
    },
    body,
  });

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = json?.message || json?.error || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const out = json?.translations?.[0]?.text;
  if (!out) throw new Error('Réponse DeepL invalide.');
  return out;
}

async function withDeeplThrottle(userId, fn) {
  const now = Date.now();
  const last = deeplThrottle.get(userId) || 0;
  const waitMs = Math.max(0, (last + 2000) - now);
  if (waitMs) await new Promise(r => setTimeout(r, waitMs));
  deeplThrottle.set(userId, Date.now());
  return fn();
}


function buildDashboardEmbed(rc) {
  const okPing = !!(rc.panelChannelId && rc.alertChannelId && rc.defRoleId);
  const okScore = !!(rc.scoreboardChannelId && rc.guildeuxRoleId);
  const okWelcome = !!rc.welcomeChannelId;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('⚙️ Dashboard de configuration')
    .setDescription('Utilise les boutons ci-dessous pour configurer le bot rapidement (mobile friendly).')
    .addFields(
      {
        name: 'État',
        value: `🛡️ Ping/Alertes: ${okPing ? '✅' : '❌'}\n📊 Scoreboard: ${okScore ? '✅' : '❌'}\n👋 Bienvenue: ${okWelcome ? '✅' : '❌'}\n📜 Règlement: ${rc.rulesChannelId && rc.rulesAccessRoleId ? '✅' : '❌'}\n👤 Admin role: ${rc.adminRoleId ? `<@&${rc.adminRoleId}>` : '—'}`,
        inline: false,
      },
      {
        name: 'Raccourci',
        value: `Panneau: ${rc.panelChannelId ? `<#${rc.panelChannelId}>` : '—'}\nAlertes: ${rc.alertChannelId ? `<#${rc.alertChannelId}>` : '—'}\nDEF: ${rc.defRoleId ? `<@&${rc.defRoleId}>` : '—'}\nScoreboard: ${rc.scoreboardChannelId ? `<#${rc.scoreboardChannelId}>` : '—'}\nGuildeux: ${rc.guildeuxRoleId ? `<@&${rc.guildeuxRoleId}>` : '—'}\nBienvenue: ${rc.welcomeChannelId ? `<#${rc.welcomeChannelId}>` : '—'}`,
        inline: false,
      },
    )
    .setFooter({ text: 'Owner only pour la configuration (setup_*).' });

  return embed;
}

function buildDashboardComponents(guildId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dash:${guildId}:ping`).setLabel('🛡️ Config Ping').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${guildId}:score`).setLabel('📊 Config Scoreboard').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${guildId}:welcome`).setLabel('👋 Config Bienvenue').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${guildId}:rules`).setLabel('📜 Config Règlement').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`dash:${guildId}:admin`).setLabel('👤 Admin').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`dash:${guildId}:status`).setLabel('📌 Status').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

async function ensureDashboardMessage(guild, channel, rc, { allowCreate = true } = {}) {
  const embed = buildDashboardEmbed(rc);
  const components = buildDashboardComponents(guild.id);

  // Try edit existing
  if (rc.dashboardChannelId === channel.id && rc.dashboardMessageId) {
    try {
      const existing = await channel.messages.fetch(rc.dashboardMessageId);
      await existing.edit({ embeds: [embed], components });
      return existing;
    } catch {
      // fallthrough
    }
  }

  if (!allowCreate) return null;

  const msg = await channel.send({ embeds: [embed], components });
  try { await msg.pin(); } catch {}

  updateGuildConfig(guild.id, { dashboard_channel_id: channel.id, dashboard_message_id: msg.id });
  return msg;
}

const cooldown = new Map(); // key: buttonKey -> lastTs
const pendingEventFix = new Map(); // key: `${userId}:${sid}` -> { participantIds, defenders }

// Prevent double-running (two bot instances => double pings)
const fs = require('fs');
const lockPath = path.join(__dirname, '..', 'bot.lock');
try {
  if (fs.existsSync(lockPath)) {
    const raw = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
    const oldPid = Number(raw);
    if (oldPid && oldPid !== process.pid) {
      // Stale-safe lock: if old PID is not alive, remove lock and continue.
      try {
        process.kill(oldPid, 0);
        console.error('[bot] Another instance is running, exiting.');
        process.exit(1);
      } catch {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } else {
      // Corrupt/empty lock: remove it
      if (!oldPid) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  }

  fs.writeFileSync(lockPath, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
} catch {}

function nowMs() { return Date.now(); }

function canPingRole(guild, me, roleId) {
  // Bot must be allowed to mention roles OR role must be mentionable.
  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, reason: 'role not found' };

  const botMember = guild.members.cache.get(me.id);
  if (!botMember) return { ok: false, reason: 'bot member not cached' };

  // If allowedMentions.roles includes the role, mention is still blocked if bot lacks permission to mention everyone? Actually this is separate.
  // We'll just check role mentionable and/or bot has MentionEveryone.
  const hasMentionEveryone = botMember.permissions.has(PermissionsBitField.Flags.MentionEveryone);
  if (!role.mentionable && !hasMentionEveryone) {
    return { ok: false, reason: `role @${role.name} not mentionable and bot lacks MentionEveryone` };
  }
  return { ok: true };
}

function buildRulesEmbed(rc) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📜 CHARTE DE LA GUILDE GTO — RP • ENTRAIDE • PVP • PVM')
    .setDescription(
      [
        '**âš”ï¸ 1) Esprit GTO**',
        'Fraternité, respect, loyauté. On se chambre, pas de manque de respect.',
        '',
        '**🤝 2) Entraide**',
        'PVM, conseils, organisation : on s’aide et on progresse ensemble.',
        '',
        '**🛡️ 3) PVP**',
        'Fair-play et discipline. On suit les calls en combat.',
        '',
        '**🏰 4) Défense**',
        'Quand l’alerte tombe, on se mobilise si possible. Pas de faux pings.',
        '',
        '**🗣️ 5) Communication**',
        'Pas de spam, bons salons, respect en vocal.',
        '',
        '**👑 6) Staff**',
        'Si souci : MP staff, pas de drama public.',
        '',
        '✅ **Pour accéder au serveur, valide le règlement via le bouton qui apparaît à ton arrivée.**',
      ].join('\n')
    )
    .setImage('attachment://rules-banner.png')
    .setFooter({ text: 'GTO — Charte & esprit de guilde.' });

  return embed;
}

function buildRulesAcceptComponents(guildId, userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rulesok:${guildId}:${userId}`)
        .setLabel('✅ J’accepte le règlement')
        .setStyle(ButtonStyle.Success)
    ),
  ];
}

async function updateProfileBox(guild, rc, targetUserId, { statusText }) {
  if (!rc.profilesChannelId) return;
  const prof = profiles.getProfile(guild.id, targetUserId);
  if (!prof?.profile_message_id) return;

  const ch = await guild.client.channels.fetch(rc.profilesChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const msg = await ch.messages.fetch(prof.profile_message_id).catch(() => null);
  if (!msg) return;

  const ignList = String(prof.ign || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const member = await guild.members.fetch(targetUserId).catch(() => null);
  const avatarUrl = member?.user?.displayAvatarURL?.({ size: 256 }) || null;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎮 Profil joueur')
    .setThumbnail(avatarUrl)
    .addFields(
      { name: 'Discord', value: `<@${targetUserId}> (\`${targetUserId}\`)`, inline: false },
      { name: 'Pseudos en jeu', value: ignList.map(x => `• **${x}**`).join('\n').slice(0, 1024) || '—', inline: false },
      { name: 'Statut', value: statusText, inline: false },
    )
    .setFooter({ text: 'Mise à jour automatique par validation staff.' });

  await msg.edit({ embeds: [embed] });
}

async function postStaffValidationAlert(guild, rc, targetUserId, choiceLabel) {
  if (!rc.validationChannelId) return;

  const ch = await guild.client.channels.fetch(rc.validationChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const staffMentions = (rc.validationStaffRoleIds || []).map(id => `<@&${id}>`).join(' ');

  const member = await guild.members.fetch(targetUserId).catch(() => null);
  const avatarUrl = member?.user?.displayAvatarURL?.({ size: 1024 }) || null;

  const prof = profiles.getProfile(guild.id, targetUserId);
  const ignList = String(prof?.ign || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🛡️ Validation staff — nouveau membre')
    .setDescription(
      `Nouveau membre : <@${targetUserId}>\n` +
      `Choix : **${choiceLabel}**\n\n` +
      `Attribuer les rôles **GTO** + **DEF** si la personne est bien un membre.`
    )
    .addFields(
      { name: '🎮 Pseudos en jeu (profil)', value: ignList.length ? ignList.map(x => `• **${x}**`).join('\n').slice(0, 1024) : '_Aucun pseudo renseigné._', inline: false },
      { name: '📌 Infos', value: member ? `• ID: \`${targetUserId}\`\n• Compte: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>\n• Arrivé: <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : `• ID: \`${targetUserId}\``, inline: false },
    )
    .setThumbnail(avatarUrl)
    .setFooter({ text: 'Clique sur Valider ou Refuser.' });

  const mode = String(choiceLabel || '').toLowerCase().includes('invité') || String(choiceLabel || '').toLowerCase().includes('invite')
    ? 'invite'
    : 'guildeux';

  const components = [
    new ActionRowBuilder().addComponents(
      mode === 'invite'
        ? new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:invite:approve`).setLabel('✅ Valider Invité').setStyle(ButtonStyle.Success)
        : new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:guildeux:approve`).setLabel('✅ Valider (GTO+DEF)').setStyle(ButtonStyle.Success),
      mode === 'invite'
        ? new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:invite:deny`).setLabel('⚔️ Refuser / Kick').setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:guildeux:deny`).setLabel('❌ Refuser (Invité)').setStyle(ButtonStyle.Danger),
      // Extra kick option for guildeux requests
      ...(mode === 'guildeux'
        ? [new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:guildeux:kick`).setLabel('⚔️ Kick').setStyle(ButtonStyle.Danger)]
        : []),
    ),
  ];

  await ch.send({
    content: staffMentions || undefined,
    embeds: [embed],
    components,
    allowedMentions: { roles: rc.validationStaffRoleIds || [] },
  });
}

async function ensureRulesMessage(channel, rc) {
  const embed = buildRulesEmbed(rc);

  // If already exists, update it (NO BUTTONS in the rules message)
  if (rc.rulesChannelId === channel.id && rc.rulesMessageId) {
    try {
      const msg = await channel.messages.fetch(rc.rulesMessageId);
      const bannerPath = path.join(__dirname, '..', 'assets', 'rules', 'rules-banner.png');
      const files = [];
      try {
        if (require('fs').existsSync(bannerPath)) {
          files.push({ attachment: bannerPath, name: 'rules-banner.png' });
        }
      } catch {}

      await msg.edit({ embeds: [embed], components: [], files });
      return msg;
    } catch {
      // recreate
    }
  }

  const bannerPath = path.join(__dirname, '..', 'assets', 'rules', 'rules-banner.png');
  const files = [];
  try {
    if (require('fs').existsSync(bannerPath)) {
      files.push({ attachment: bannerPath, name: 'rules-banner.png' });
    }
  } catch {}

  const msg = await channel.send({ embeds: [embed], components: [], files });
  try { await msg.pin(); } catch {}
  updateGuildConfig(rc.guildId, { rules_channel_id: channel.id, rules_message_id: msg.id });
  return msg;
}

async function ensurePanelMessage(channel, rc) {
  // Ensure panel record exists; keep any per-channel alert override if already set.
  const existing = panel.getPanel(rc.guildId, channel.id);
  panel.upsertPanel(rc.guildId, channel.id, {
    title: rc.panelTitle,
    alertChannelId: existing?.alert_channel_id || rc.alertChannelId,
  });
  const p = panel.getPanel(rc.guildId, channel.id);
  const components = panel.buildComponents(rc.guildId, channel.id);

  const title = p?.title || rc.panelTitle;

  // Embed = best "official announcement" look on Discord
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c) // alert red
    .setAuthor({ name: 'GTO — Centre de commandement', iconURL: channel.guild?.iconURL?.({ size: 128 }) || undefined })
    .setTitle(`⚔️ ALERTE DEF — ${title}`)
    .setDescription('**EN CAS D’ATTAQUE : sélectionne la guilde et déclenche l’alerte.**')
    .addFields(
      {
        name: '📣 Procédure',
        value: '1) Identifie la guilde concernée\n2) Clique sur le bouton correspondant\n3) Renforts en route',
        inline: false,
      },
      {
        name: '🎯 Effet',
        value: 'Ping **DEF** + ping rôle de guilde dans le salon d’alerte.',
        inline: false,
      },
      {
        name: '🛡️ Discipline',
        value: '• Pas de spam\n• Une erreur = on assume, on corrige, et on se regroupe',
        inline: false,
      },
    )
    .setImage('attachment://pingdef-banner.png')
    .setFooter({ text: '⬇️ Clique sur un bouton ⬇️' });

  const content = '';

  const bannerPath = path.join(__dirname, '..', 'assets', 'panel', 'pingdef-banner.png');
  const files = [];
  try {
    if (require('fs').existsSync(bannerPath)) {
      files.push({ attachment: bannerPath, name: 'pingdef-banner.png' });
    }
  } catch {}

  if (p && p.message_id) {
    try {
      const msg = await channel.messages.fetch(p.message_id);
      await msg.edit({ content, embeds: [embed], components, files });
      return msg;
    } catch {
      // fallthrough: recreate
    }
  }

  const msg = await channel.send({ content, embeds: [embed], components, files });
  panel.setPanelMessageId(rc.guildId, channel.id, msg.id);
  // Always pin the panel message if possible
  try { await msg.pin(); } catch {}
  return msg;
}

function groupCommandName(name) {
  if (name.startsWith('setup_')) return '🧩 Installation / Setup (Owner only)';
  if (name.startsWith('panneau_') || name.startsWith('guilde_')) return '📌 Panneau & Guilde (Admin)';
  if (name.startsWith('profile_')) return '🎮 Profils (Staff)';
  if (['clean', 'lock_write', 'role_id'].includes(name)) return '🛠️ Outils (Admin)';
  return '📎 Autres';
}

function chunkLines(lines, maxLen = 1024) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const add = (cur ? '\n' : '') + line;
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function buildHelpEmbedFromCommands(commands) {
  const byGroup = new Map();

  for (const c of commands) {
    const group = groupCommandName(c.name);
    if (!byGroup.has(group)) byGroup.set(group, []);

    const opts = (c.options || [])
      .map(o => `${o.required ? '<' : '['}${o.name}${o.required ? '>' : ']'}`)
      .join(' ');

    const usage = opts ? `/${c.name} ${opts}` : `/${c.name}`;
    const desc = c.description || '';
    byGroup.get(group).push(`• \`${usage}\` — ${desc}`);
  }

  // Stable group order
  const groupOrder = [
    '🧩 Installation / Setup (Owner only)',
    '📌 Panneau & Guilde (Admin)',
    '🛠️ Outils (Admin)',
    '🎮 Profils (Staff)',
    '📎 Autres',
  ];

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📘 Commandes du bot GTO — Guide staff')
    .setDescription('Liste auto-générée depuis les slash commands enregistrées sur le serveur.')
    .setTimestamp();

  for (const group of groupOrder) {
    const lines = byGroup.get(group);
    if (!lines || !lines.length) continue;
    const chunks = chunkLines(lines);
    chunks.forEach((val, idx) => {
      const name = idx === 0 ? group : `${group} (suite)`;
      embed.addFields({ name, value: val, inline: false });
    });
  }

  // Extra notes for features that are not slash commands
  embed.addFields({
    name: 'ℹ️ Notes',
    value:
      '• Le bouton **✍️ Modifier** sur une box profil est réservé au staff (Meneur/BD).\n' +
      '• Les boutons onboarding (règlement / guildeux / invité / validation staff) sont gérés via interactions.',
    inline: false,
  });

  embed.setFooter({ text: 'Astuce: utilisez /setup_dashboard pour installer rapidement.' });
  return embed;
}

async function ensureEventScoreboard(guild, rc) {
  if (!rc.eventScoreboardChannelId) return;
  const ch = await guild.client.channels.fetch(rc.eventScoreboardChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const top = ev.listScores(guild.id, 25);
  const lines = top.map((r, i) => `**${String(i + 1).padStart(2, '0')}.** <@${r.user_id}> — **${r.points}** pts`).join('\n') || 'Aucun score pour le moment.';

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🏆 Classement événements — All-time')
    .setDescription(lines)
    .setFooter({ text: 'Validé par le staff à partir des preuves (screens).' });

  const state = ev.getScoreboardState(guild.id);
  if (state?.message_id && state?.channel_id === ch.id) {
    const msg = await ch.messages.fetch(state.message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed] });
      return msg;
    }
  }

  const msg = await ch.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  ev.setScoreboardState(guild.id, ch.id, msg.id);
  return msg;
}

async function ensureEventAdminPanel(guild, rc) {
  // Panel lives in a staff-only channel (by default: event validation channel)
  const channelId = rc.eventAdminChannelId || rc.eventValidationChannelId;
  if (!channelId) return;

  const ch = await guild.client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(0x2c3e50)
    .setTitle('🛠️ Events Perco — Panneau staff (admin)')
    .setDescription(
      [
        'Ce panneau reste actif **même après la fin** : corrections, kick, resync…',
        '',
        'Actions principales :',
        '• 🔄 Resync = reconstruit le classement à partir de la DB',
        '• ➕ Add points = ajoute/enlève des points à un joueur',
        '• ✏️ Set points = fixe les points exacts d\'un joueur',
        '• 🧹 Remove player = supprime un joueur du classement (ex: kick event)',
      ].join('\n')
    )
    .setFooter({ text: 'Réservé staff (rôles validation). Toutes les actions mettent à jour le scoreboard.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('evadm:resync').setLabel('🔄 Resync classement').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('evadm:add').setLabel('➕ Add points').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('evadm:set').setLabel('✏️ Set points').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('evadm:remove').setLabel('🧹 Remove player').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('evadm:reset').setLabel('🧨 Reset saison').setStyle(ButtonStyle.Danger),
  );

  // Try edit existing
  if (rc.eventAdminMessageId) {
    const existing = await ch.messages.fetch(rc.eventAdminMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] }).catch(() => {});
      return existing;
    }
  }

  const msg = await ch.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch {}
  updateGuildConfig(guild.id, { event_admin_channel_id: ch.id, event_admin_message_id: msg.id });
  return msg;
}

async function postOfficialEventResult(guild, rc, sub, { status, defenders, participantIds, validatedBy, reason }) {
  // Post in the parent proofs channel (the "event" channel), not inside the thread.
  const parentId = rc.eventProofsChannelId;
  if (!parentId) return null;

  const parent = await guild.client.channels.fetch(parentId).catch(() => null);
  if (!parent || !parent.isTextBased()) return null;

  // Fetch original message + attachments from the thread
  const thread = sub?.proofs_channel_id ? await guild.client.channels.fetch(sub.proofs_channel_id).catch(() => null) : null;
  const original = thread && thread.isTextBased() ? await thread.messages.fetch(sub.proofs_message_id).catch(() => null) : null;

  const files = [];

  // Add official banner image
  try {
    const bannerPath = path.join(__dirname, '..', 'assets', 'event-official-banner.jpg');
    if (require('fs').existsSync(bannerPath)) {
      files.push({ attachment: bannerPath, name: 'event-official-banner.jpg' });
    }
  } catch {}

  if (original) {
    const atts = [...original.attachments.values()].filter(a => (a.contentType || '').startsWith('image/'));
    for (let i = 0; i < Math.min(2, atts.length); i++) {
      const a = atts[i];
      try {
        const resp = await fetch(a.url);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        files.push({ attachment: buf, name: `event-${sub.id}-${i + 1}.png` });
      } catch {}
    }
  }

  const isApproved = status === 'approved';
  const embed = new EmbedBuilder()
    .setColor(isApproved ? 0x2ecc71 : 0xe74c3c)
    .setTitle(isApproved ? '✅ Combat validé — OFFICIEL' : '❌ Combat refusé — OFFICIEL')
    .setDescription(
      [
        `**Preuve :** ${original ? `[lien](${original.url})` : '—'}`,
        `**Thread :** ${thread ? `<#${thread.id}>` : '—'}`,
        `**Staff :** <@${validatedBy}>`,
      ].join('\n')
    )
    .addFields(
      { name: '👥 Participants', value: participantIds?.length ? participantIds.map(id => `<@${id}>`).join(' ') : '—', inline: false },
      isApproved
        ? { name: '🏆 Points', value: `**+${defenders}** pts / joueur`, inline: false }
        : { name: '📝 Raison', value: String(reason || '—').slice(0, 1024), inline: false },
    )
    .setImage('attachment://event-official-banner.jpg')
    .setTimestamp();

  return parent.send({ embeds: [embed], files, allowedMentions: { parse: [] } });
}

async function postEventScreen(guild, rc, sub, { status, defenders, participantIds, validatedBy, reason }) {
  if (!rc.eventScreensChannelId) return null;
  const ch = await guild.client.channels.fetch(rc.eventScreensChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;

  // Fetch original proof message to reupload images
  const thread = sub?.proofs_channel_id ? await guild.client.channels.fetch(sub.proofs_channel_id).catch(() => null) : null;
  const original = thread && thread.isTextBased() ? await thread.messages.fetch(sub.proofs_message_id).catch(() => null) : null;

  const files = [];
  if (original) {
    const atts = [...original.attachments.values()].filter(a => (a.contentType || '').startsWith('image/'));
    for (let i = 0; i < Math.min(2, atts.length); i++) {
      const a = atts[i];
      try {
        const resp = await fetch(a.url);
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        files.push({ attachment: buf, name: `screen-${sub.id}-${i + 1}.png` });
      } catch {}
    }
  }

  const isApproved = status === 'approved';
  const embed = new EmbedBuilder()
    .setColor(isApproved ? 0x2ecc71 : 0xe74c3c)
    .setTitle(isApproved ? '✅ Screen validé' : '❌ Screen refusé')
    .setDescription(`SID **${sub.id}** • par <@${validatedBy}>\nThread: ${thread ? `<#${thread.id}>` : '—'}\nPreuve: ${original ? `[lien](${original.url})` : '—'}`)
    .addFields(
      { name: 'Participants', value: participantIds?.length ? participantIds.map(id => `<@${id}>`).join(' ') : '—', inline: false },
      isApproved
        ? { name: 'Points', value: `**+${defenders} pts** / joueur`, inline: false }
        : { name: 'Raison', value: String(reason || '—').slice(0, 1024), inline: false },
    )
    .setTimestamp();

  // Edit if exists, else create
  if (sub.screen_message_id) {
    const msg = await ch.messages.fetch(sub.screen_message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], files });
      return msg;
    }
  }

  const msg = await ch.send({ embeds: [embed], files, allowedMentions: { parse: [] } });
  try { ev.setScreenMessageId(sub.id, msg.id); } catch {}
  return msg;
}

async function closeEventThread(guild, sub) {
  const thread = sub?.proofs_channel_id ? await guild.client.channels.fetch(sub.proofs_channel_id).catch(() => null) : null;
  if (!thread || !thread.isThread?.()) return;
  try { await thread.setLocked(true, 'Event perco traité (staff)'); } catch {}
  try { await thread.setArchived(true, 'Event perco traité (staff)'); } catch {}
}

function parisParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    ymd: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.error) {
    const msg = data?.error?.text || `HTTP ${resp.status}`;
    if (String(msg).toLowerCase().includes('date not available')) {
      throw new Error("Données indisponibles pour cette date (API). Réessaie dans quelques minutes.");
    }
    throw new Error(msg);
  }
  return data;
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      accept: 'text/html,*/*;q=0.8',
      // évite quelques blocages basiques
      'user-agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0; +https://discord.com)'
    },
  });
  const text = await resp.text().catch(() => null);
  if (!resp.ok || !text) throw new Error(`HTTP ${resp.status}`);
  return text;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code)) return _;
      try { return String.fromCharCode(code); } catch { return _; }
    });
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseKrosmozAlmanax(html, { gameLabel = 'DOFUS Touch' } = {}) {
  // On isole le bloc "Bonus et Quêtes DOFUS Touch"
  const h4 = new RegExp(`<h4>\\s*Bonus[^<]*${gameLabel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*<\\/h4>`, 'i');
  const start = html.search(h4);
  if (start < 0) return null;

  const slice = html.slice(start, start + 20000); // suffisant pour le bloc

  const bonusType = (() => {
    const m = slice.match(/Bonus\s*:\s*([^<\n\r]+)/i);
    return stripTags(m?.[1] || '').trim() || '—';
  })();

  const bonusDesc = (() => {
    // Le texte descriptif est juste après <div class="more"> ...
    const m = slice.match(/<div class="more">([\s\S]*?)<div class="more-infos">/i);
    return stripTags(m?.[1] || '').trim() || '—';
  })();

  const quest = (() => {
    const m = slice.match(/<p>\s*Qu[^<]*te\s*:\s*([^<]+)<\/p>/i);
    return stripTags(m?.[1] || '').trim() || '—';
  })();

  const offeringText = (() => {
    const m = slice.match(/<p class="fleft">([\s\S]*?)<\/p>/i);
    return stripTags(m?.[1] || '').trim() || '—';
  })();

  let itemQty = null;
  let itemName = '—';
  const mOff = offeringText.match(/R[ée]cup[ée]rer\s+(\d+)\s+(.+?)\s+et\s+rapporter/i);
  if (mOff) {
    itemQty = Number(mOff[1]);
    itemName = mOff[2].trim();
  }

  return {
    bonusType,
    bonusDesc,
    quest,
    offeringText,
    itemQty: Number.isFinite(itemQty) ? itemQty : null,
    itemName: itemName || '—',
  };
}

function parisYmdForDaysAhead(daysAhead = 0) {
  const base = new Date();
  base.setDate(base.getDate() + Number(daysAhead || 0));
  return parisParts(base).ymd;
}

async function getKrosmozAlmanaxTouch({ ymd, lang = 'fr' } = {}) {
  const url = `https://www.krosmoz.com/${lang}/almanax/${ymd}`;
  const html = await fetchText(url);
  const parsed = parseKrosmozAlmanax(html, { gameLabel: 'DOFUS Touch' });
  if (!parsed) throw new Error("Impossible d'extraire l'Almanax DOFUS Touch depuis Krosmoz (HTML changé ?)");
  return { url, ...parsed };
}

async function buildAlmanaxEmbed({ daysAhead = 0 } = {}) {
  const tz = 'Europe/Paris';
  const lang = 'fr';
  const ymd = parisYmdForDaysAhead(daysAhead);

  const a = await getKrosmozAlmanaxTouch({ ymd, lang });

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`📜 Almanax (Touch) — J+${daysAhead}`)
    .setDescription(`**Date :** ${ymd}`)
    .addFields(
      { name: '✨ Bonus', value: `**${a.bonusType}** — ${String(a.bonusDesc).slice(0, 900)}`.slice(0, 1024) || '—', inline: false },
      { name: '🧭 Quête', value: String(a.quest).slice(0, 1024) || '—', inline: false },
      { name: '🎁 Offrande', value: a.itemQty ? `**${a.itemQty}×** ${a.itemName}` : String(a.offeringText).slice(0, 1024), inline: false },
    )
    .setFooter({ text: `Source: krosmoz.com • TZ ${tz}` });
}

async function buildAlmanaxSummaryEmbed() {
  const tz = 'Europe/Paris';
  const lang = 'fr';
  const ymd = parisYmdForDaysAhead(0);

  const a = await getKrosmozAlmanaxTouch({ ymd, lang });

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📜 Almanax (Touch) — Résumé du jour')
    .setDescription(
      [
        `**Date :** ${ymd}`,
        `**Bonus :** ${a.bonusType} — ${String(a.bonusDesc).slice(0, 250)}`,
        `**Offrande :** ${a.itemQty ? `${a.itemQty}× ` : ''}${a.itemName || a.offeringText}`,
        '',
        '➡️ Pour les détails : **/almanax**',
      ].join('\n')
    )
    .setFooter({ text: `Auto • 00:00 • TZ ${tz}` });
}

async function maybeDailyAlmanax(guild, rc) {
  if (!rc.almanaxChannelId) return;

  const { ymd, hour, minute } = parisParts();
  if (!(hour === 0 && minute === 0)) return;

  if (rc.almanaxLastPostYmd === ymd) return;

  const ch = await guild.client.channels.fetch(rc.almanaxChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const embed = await buildAlmanaxSummaryEmbed();
  await ch.send({ embeds: [embed] }).catch(() => {});

  updateGuildConfig(guild.id, { almanax_last_post_ymd: ymd });
}

async function ensureHelpMessage(guild, rc) {
  if (!rc.helpChannelId) return;
  const ch = await guild.client.channels.fetch(rc.helpChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  // Fetch registered commands for THIS guild to auto-update
  let commands = [];
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    commands = await rest.get(Routes.applicationGuildCommands(guild.client.user.id, guild.id));
  } catch (e) {
    console.warn('[bot] could not fetch guild commands for help box:', e?.message || e);
  }

  const embed = buildHelpEmbedFromCommands(commands);

  if (rc.helpMessageId) {
    const existing = await ch.messages.fetch(rc.helpMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] });
      return;
    }
  }

  const msg = await ch.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  updateGuildConfig(guild.id, { help_channel_id: ch.id, help_message_id: msg.id });
}

function ankamaTagToSlug(inputRaw) {
  const raw = String(inputRaw || '').trim();
  if (!raw) return null;

  // Accept: pseudo#1234 OR pseudo-1234 OR full URL.
  const urlMatch = raw.match(/profil-ankama\/([a-zA-Z0-9._\-]+-\d{1,10})/);
  if (urlMatch) return urlMatch[1];

  // If already pseudo-1234
  if (/^[^\s#]+-\d{1,10}$/.test(raw)) return raw;

  // pseudo#1234
  const m = raw.match(/^(.+?)#(\d{1,10})$/);
  if (!m) return null;

  let pseudo = m[1].trim();
  const code = m[2];

  // Krosmoz/Ankama uses hyphens
  pseudo = pseudo.replace(/\s+/g, '-');
  // keep only safe url chars
  pseudo = pseudo.replace(/[^a-zA-Z0-9._\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  if (!pseudo) return null;
  return `${pseudo}-${code}`;
}

async function ensureAnkamaProfilePanel(guild, channel, rc) {
  if (!channel || !channel.isTextBased?.()) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔎 Profils Ankama — Contrôle rapide')
    .setDescription(
      [
        'Entre un pseudo au format **pseudo#1234** (comme en jeu).',
        'Le bot convertit automatiquement en **pseudo-1234** et te donne le lien cliquable.',
      ].join('\n')
    )
    .addFields(
      { name: 'Exemple', value: '`MonPseudo#6715` → <https://account.ankama.com/fr/profil-ankama/MonPseudo-6715>', inline: false },
    )
    .setFooter({ text: 'Astuce: accepte aussi un lien Ankama ou pseudo-1234.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ankprof:open:${guild.id}`)
      .setLabel('🔗 Ouvrir un profil')
      .setStyle(ButtonStyle.Primary)
  );

  // edit existing message if possible
  if (rc.ankamaProfileMessageId) {
    const existing = await channel.messages.fetch(rc.ankamaProfileMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components: [row] }).catch(() => {});
      return;
    }
  }

  const msg = await channel.send({ embeds: [embed], components: [row] });
  try { await msg.pin(); } catch {}
  updateGuildConfig(guild.id, { ankama_profile_channel_id: channel.id, ankama_profile_message_id: msg.id });
}

function isGtoOrDefMember(member, rc) {
  const ridG = rc.validationGtoRoleId;
  const ridD = rc.validationDefRoleId;
  if (!member?.roles?.cache) return false;
  return Boolean((ridG && member.roles.cache.has(ridG)) || (ridD && member.roles.cache.has(ridD)));
}

function sanitizeDofusbookUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  // accept dofusbook only (touch/normal). You can widen later if needed.
  const host = u.hostname.toLowerCase();
  if (!host.includes('dofusbook')) return null;
  return u.toString();
}

const DOFUS_TOUCH_CLASSES = [
  { key: 'feca', label: 'Féca' },
  { key: 'osamodas', label: 'Osamodas' },
  { key: 'enutrof', label: 'Enutrof' },
  { key: 'sram', label: 'Sram' },
  { key: 'xelor', label: 'Xélor' },
  { key: 'ecaflip', label: 'Ecaflip' },
  { key: 'eniripsa', label: 'Eniripsa' },
  { key: 'iop', label: 'Iop' },
  { key: 'cra', label: 'Cra' },
  { key: 'sadida', label: 'Sadida' },
  { key: 'sacrieur', label: 'Sacrieur' },
  { key: 'pandawa', label: 'Pandawa' },
];

const DOFUS_TOUCH_ELEMENTS = [
  { key: 'air', label: 'Air' },
  { key: 'eau', label: 'Eau' },
  { key: 'feu', label: 'Feu' },
  { key: 'terre', label: 'Terre' },
  { key: 'multi', label: 'Multi' },
  { key: 'tank', label: 'Tank' },
  { key: 'dopou', label: 'Dopou' },
  { key: 'hybride', label: 'Hybride' },
];

const dofusbookDrafts = new Map(); // key: guildId:userId -> { classKey, elementKey }

function getDraft(guildId, userId) {
  return dofusbookDrafts.get(`${guildId}:${userId}`) || { classKey: null, elementKey: null };
}

function setDraft(guildId, userId, patch) {
  const key = `${guildId}:${userId}`;
  const cur = getDraft(guildId, userId);
  const next = { ...cur, ...patch };
  dofusbookDrafts.set(key, next);
  return next;
}

function renderBuildLine(row) {
  const cls = DOFUS_TOUCH_CLASSES.find(c => c.key === row.class_key)?.label || row.class_key;
  const el = DOFUS_TOUCH_ELEMENTS.find(e => e.key === row.element_key)?.label || row.element_key;
  const name = String(row.build_name || 'Build').slice(0, 60);
  const lvl = Number(row.level) || 0;
  const url = String(row.url || '').trim();
  return `• **${name}** — *${cls}* — **${el}** — **lvl ${lvl}** — <@${row.user_id}> — [Dofusbook](${url})`;
}

function buildDofusbookPanelEmbed(rows) {
  const byClass = new Map();
  for (const c of DOFUS_TOUCH_CLASSES) byClass.set(c.key, []);
  for (const r of rows) {
    if (!byClass.has(r.class_key)) byClass.set(r.class_key, []);
    byClass.get(r.class_key).push(r);
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('📚 Dofusbook (Touch) — Builds de la guilde')
    .setDescription('Panneau de liens pour retrouver rapidement des stuffs. Tri par niveau décroissant.')
    .setFooter({ text: 'Ajout réservé aux membres GTO/DEF.' });

  for (const c of DOFUS_TOUCH_CLASSES) {
    const list = byClass.get(c.key) || [];
    list.sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0));
    const shown = list.slice(0, 8);
    let value = shown.length ? shown.map(renderBuildLine).join('\n') : '—';
    if (list.length > shown.length) value += `\n… +${list.length - shown.length} autre(s)`;
    embed.addFields({ name: c.label, value: value.slice(0, 1024), inline: false });
  }

  return embed;
}

function buildDofusbookPanelComponents(guildId) {
  // IMPORTANT (Discord constraint): a select menu takes the full width of a row.
  // So we must use one select per ActionRow.
  const rowClass = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`dbp:class:${guildId}`)
      .setPlaceholder('Choisir une classe')
      .addOptions(DOFUS_TOUCH_CLASSES.map(c => ({ label: c.label, value: c.key })))
  );

  const rowElem = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`dbp:elem:${guildId}`)
      .setPlaceholder('Choisir un élément')
      .addOptions(DOFUS_TOUCH_ELEMENTS.map(e => ({ label: e.label, value: e.key })))
  );

  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dbp:add:${guildId}`).setLabel('➕ Ajouter un build').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dbp:mine:${guildId}`).setLabel('🧩 Mes builds').setStyle(ButtonStyle.Secondary),
  );

  return [rowClass, rowElem, rowButtons];
}

async function ensureDofusbookPanel(guild, channel, rc) {
  if (!channel || !channel.isTextBased?.()) return;

  const rows = db.prepare('SELECT * FROM dofusbook_builds WHERE guild_id=?').all(guild.id);
  const embed = buildDofusbookPanelEmbed(rows);
  const components = buildDofusbookPanelComponents(guild.id);

  if (rc.dofusbookPanelMessageId) {
    const existing = await channel.messages.fetch(rc.dofusbookPanelMessageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed], components }).catch(() => {});
      return;
    }
  }

  const msg = await channel.send({ embeds: [embed], components });
  try { await msg.pin(); } catch {}
  updateGuildConfig(guild.id, { dofusbook_panel_channel_id: channel.id, dofusbook_panel_message_id: msg.id });
}

// Invite tracking (best effort)
const inviteCache = new Map(); // guildId -> Collection(code -> invite)

async function refreshInvites(guild) {
  try {
    if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, invites);
  } catch {
    // ignore
  }
}

async function sendSurveillance(guild, rc, embed) {
  if (!rc.surveillanceChannelId) return;
  const ch = await guild.client.channels.fetch(rc.surveillanceChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function sendActivityLog(guild, rc, embed) {
  if (!rc.activityLogChannelId) return;
  const ch = await guild.client.channels.fetch(rc.activityLogChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function getAuditActor(guild, { type, targetId, windowMs = 15_000 }) {
  // Best-effort: audit logs can be delayed/ambiguous.
  try {
    if (!guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ViewAuditLog)) return null;
    const logs = await guild.fetchAuditLogs({ limit: 6, type });
    const now = Date.now();
    const entry = logs.entries.find(e => {
      if (targetId && e.target?.id !== targetId) return false;
      return now - e.createdTimestamp < windowMs;
    });
    return entry ? { executor: entry.executor, reason: entry.reason || null, entry } : null;
  } catch {
    return null;
  }
}

async function ensureActivityLogHeader(guild, rc) {
  if (!rc.activityLogChannelId) return;
  const ch = await guild.client.channels.fetch(rc.activityLogChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(0x2c3e50)
    .setTitle('👁️ Activity Logs — Serveur')
    .setDescription('Ce salon enregistre automatiquement : commandes, messages modifiés/supprimés, etc. (aucune mention)')
    .addFields(
      { name: 'Notes', value: '• Certains contenus peuvent être indisponibles si Discord ne fournit pas le message (cache/partials).\n• Les suppressions via /clean sont loggées en bloc.', inline: false },
    )
    .setFooter({ text: 'Logs silencieux (no ping).' });

  // Pin a single header (best effort)
  const recent = await ch.messages.fetch({ limit: 10 }).catch(() => null);
  const existing = recent?.find(m => m.author?.id === guild.client.user.id && m.embeds?.[0]?.title === '👁️ Activity Logs — Serveur');
  if (existing) return;

  const msg = await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
  try { await msg.pin(); } catch {}
}

async function registerCommands(client) {
  const commands = [
    // Message context menu — translation (ephemeral)
    new ContextMenuCommandBuilder()
      .setName('Traduire FR')
      .setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder()
      .setName('Translate EN')
      .setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder()
      .setName('Traducir ES')
      .setType(ApplicationCommandType.Message),
    new SlashCommandBuilder()
      .setName('panneau_creer')
      .setDescription('Créer ou mettre à jour le panneau de boutons')
      .addChannelOption(o => o.setName('canal').setDescription('Canal du panneau (boutons)').setRequired(true))
      .addChannelOption(o => o.setName('canal_alerte').setDescription('Canal des alertes (pings)').setRequired(true))
      .addStringOption(o => o.setName('titre').setDescription('Titre du panneau').setRequired(false))
      .addBooleanOption(o => o.setName('epingle').setDescription('Épingler le message du panneau').setRequired(false)),

    new SlashCommandBuilder()
      .setName('panneau_actualiser')
      .setDescription('Actualiser les boutons du panneau')
      .addChannelOption(o => o.setName('canal').setDescription('Canal du panneau').setRequired(true)),

    new SlashCommandBuilder()
      .setName('guilde_ajouter')
      .setDescription('Ajouter / modifier un bouton de guilde')
      .addStringOption(o => o.setName('nom').setDescription('Nom interne (ex: GTO)').setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Rôle à ping pour cette guilde').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Texte du bouton').setRequired(false))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji (optionnel)').setRequired(false))
      .addAttachmentOption(o => o.setName('image').setDescription('Blason (image upload) â†’ sera converti en emoji').setRequired(false))
      .addIntegerOption(o => o.setName('ordre').setDescription('Ordre (optionnel)').setRequired(false))
      .addStringOption(o => o.setName('prefixe').setDescription('Préfixe Unicode (ex: 🚨⚠️) pour les notifications').setRequired(false)),

    new SlashCommandBuilder()
      .setName('guilde_supprimer')
      .setDescription('Supprimer un bouton de guilde')
      .addStringOption(o => o.setName('nom').setDescription('Nom interne à supprimer').setRequired(true)),

    new SlashCommandBuilder()
      .setName('role_id')
      .setDescription("Afficher l'ID d'un rôle (debug)")
      .addRoleOption(o => o.setName('role').setDescription('Rôle').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_admin')
      .setDescription('Configurer le rôle admin autorisé (owner only)')
      .addRoleOption(o => o.setName('role').setDescription('Rôle admin (ex: Dev mode)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_ping')
      .setDescription('Configurer le panneau de ping (owner only)')
      .addChannelOption(o => o.setName('panneau').setDescription('Salon du panneau (boutons)').setRequired(true))
      .addChannelOption(o => o.setName('alertes').setDescription('Salon des alertes (pings)').setRequired(true))
      .addRoleOption(o => o.setName('def_role').setDescription('Rôle DEF à ping').setRequired(true))
      .addStringOption(o => o.setName('titre').setDescription('Titre du panneau').setRequired(false))
      .addIntegerOption(o => o.setName('cooldown').setDescription('Cooldown en secondes').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setup_scoreboard')
      .setDescription('Configurer le scoreboard guildeux (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon du classement').setRequired(true))
      .addRoleOption(o => o.setName('role_guildeux').setDescription('Rôle @guildeux').setRequired(true))
      .addIntegerOption(o => o.setName('top').setDescription('Top N (ex: 25)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('scoreboard_weekly_run')
      .setDescription('Annonce hebdo + reset du scoreboard pings (admin)')
      .addBooleanOption(o => o.setName('reset').setDescription('Reset les scores après annonce (défaut: true)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('almanax')
      .setDescription("Afficher l'Almanax Dofus (via almanax-api)")
      .addIntegerOption(o => o
        .setName('jours')
        .setDescription("0 = aujourd'hui, 1 = demain, etc. (max 30)")
        .setMinValue(0)
        .setMaxValue(30)
        .setRequired(false))
      .addIntegerOption(o => o
        .setName('prochains')
        .setDescription('Afficher les X prochains jours (1-10)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(false))
      .addStringOption(o => o
        .setName('prochain_bonus')
        .setDescription('Trouver le prochain Almanax avec ce bonus (slug anglais, ex: full-of-life)')
        .setRequired(false))
      .addBooleanOption(o => o
        .setName('bonus_disponibles')
        .setDescription('Lister les bonus disponibles (FR)')
        .setRequired(false))
      .addBooleanOption(o => o
        .setName('aide')
        .setDescription('Afficher l’aide de la commande')
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('setup_status')
      .setDescription('Afficher la config actuelle (owner only)'),

    new SlashCommandBuilder()
      .setName('setup_dashboard')
      .setDescription('Créer/mettre à jour le dashboard de configuration (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon où poster le dashboard').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_welcome')
      .setDescription('Configurer le message de bienvenue (owner only)')
      // Important: restrict to text channels to avoid “identifiant de salon invalideâ€ on mobile
      .addChannelOption(o => o
        .setName('salon')
        .setDescription("Salon d'arrivée / bienvenue")
        .addChannelTypes(0, 5) // 0=GuildText, 5=GuildAnnouncement
        .setRequired(true))
      .addChannelOption(o => o
        .setName('chat_arrive')
        .setDescription('Salon chat-arrive (bouton GIF poste ici)')
        .addChannelTypes(0, 5)
        .setRequired(false))
      .addStringOption(o => o.setName('guilde').setDescription('Nom de la guilde (ex: GTO)').setRequired(false))
      .addBooleanOption(o => o.setName('ping_everyone').setDescription('Mentionner @everyone sur chaque arrivée').setRequired(false))
      .addRoleOption(o => o.setName('role_guildeux').setDescription('Rôle donné aux membres de la guilde').setRequired(false))
      .addRoleOption(o => o.setName('role_invite').setDescription('Rôle donné aux invités').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setup_almanax')
      .setDescription("Configurer Almanax (salon dédié + post quotidien) (owner only)")
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon où poster Almanax (quotidien + commandes)')
        .addChannelTypes(0, 5)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_reglement')
      .setDescription('Configurer le salon règlement + validation (owner only)')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon #reglement')
        .addChannelTypes(0, 5)
        .setRequired(true))
      .addRoleOption(o => o.setName('role_acces').setDescription("Rôle donné après validation du règlement").setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_validation_staff')
      .setDescription('Configurer la validation staff (owner only)')
      // Required options must be declared before optional ones (Discord API constraint)
      .addChannelOption(o => o.setName('salon').setDescription('Salon lead / validation').addChannelTypes(0,5).setRequired(true))
      .addRoleOption(o => o.setName('staff1').setDescription('Rôle staff autorisé #1').setRequired(true))
      .addRoleOption(o => o.setName('role_gto').setDescription('Rôle GTO à attribuer').setRequired(true))
      .addRoleOption(o => o.setName('role_def').setDescription('Rôle DEF à attribuer').setRequired(true))
      .addRoleOption(o => o.setName('staff2').setDescription('Rôle staff autorisé #2').setRequired(false)),

    new SlashCommandBuilder()
      .setName('setup_profiles')
      .setDescription('Configurer le salon des profils (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon où poster les profils (IGN)').addChannelTypes(0,5).setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_profil_ankama')
      .setDescription('Configurer le panneau de contrôle des profils Ankama (owner only)')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon dédié où poster le panneau')
        .addChannelTypes(0, 5)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_dofusbook_panel')
      .setDescription('Configurer le panneau des builds Dofusbook (Touch) (owner only)')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon dédié où poster le panneau')
        .addChannelTypes(0, 5)
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName('generateurstuff')
      .setDescription('Poster le générateur de stuffs opti PVP (admin only)')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon où poster la box (défaut: salon actuel)')
        .addChannelTypes(0, 5)
        .setRequired(false)),

    new SlashCommandBuilder()
      .setName('clean')
      .setDescription('Nettoyer les messages dans ce salon (admin)')
      .addIntegerOption(o => o.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('metiers-install')
      .setDescription('Installer le dashboard métiers (admin only)')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('metiers-emojisync')
      .setDescription('Synchroniser les emojis métiers (admin only)')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('metiers-testpingchannel')
      .setDescription('DEBUG: tester envoi dans le salon de demandes métiers')
      .setDMPermission(false),

    new SlashCommandBuilder()
      .setName('lock_write')
      .setDescription("Bloquer l'écriture dans ce salon (owner only)")
      .addChannelOption(o => o.setName('salon').setDescription('Salon à verrouiller').addChannelTypes(0,5).setRequired(true))
      .addRoleOption(o => o.setName('role_autorise1').setDescription('Rôle autorisé à écrire #1').setRequired(true))
      .addRoleOption(o => o.setName('role_autorise2').setDescription('Rôle autorisé à écrire #2').setRequired(false))
      .addRoleOption(o => o.setName('role_autorise3').setDescription('Rôle autorisé à écrire #3').setRequired(false))
      .addBooleanOption(o => o.setName('unlock').setDescription('Déverrouiller').setRequired(false)),

    new SlashCommandBuilder()
      .setName('profile_reset')
      .setDescription('Supprimer le profil (et la box) d\'un membre (admin)')
      .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true)),

    new SlashCommandBuilder()
      .setName('profile_set')
      .setDescription('Modifier les pseudos en jeu d\'un membre (admin)')
      .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
      .addStringOption(o => o.setName('pseudos').setDescription('Un pseudo par ligne').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_help')
      .setDescription('Poster/mettre à jour la box des commandes (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon du guide staff').addChannelTypes(0,5).setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_surveillance')
      .setDescription('Configurer le salon de surveillance (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon logs (join/leave/invite)').addChannelTypes(0,5).setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_activity_logs')
      .setDescription('Configurer le salon des logs activité (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon logs activité (edit/delete/commands)').addChannelTypes(0,5).setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_events')
      .setDescription('Configurer le système d\'événements perco (owner only)')
      .addChannelOption(o => o.setName('preuves').setDescription('Salon où les joueurs postent les screens').addChannelTypes(0,5).setRequired(true))
      .addChannelOption(o => o.setName('validation').setDescription('Salon staff de validation').addChannelTypes(0,5).setRequired(true))
      .addChannelOption(o => o.setName('classement').setDescription('Salon du classement all-time').addChannelTypes(0,5).setRequired(true))
      .addChannelOption(o => o.setName('screens').setDescription('Salon où poster les screens OFFICIELS (optionnel)').addChannelTypes(0,5).setRequired(false))
      .addChannelOption(o => o.setName('panneau').setDescription('Salon où placer la box de soumission (optionnel)').addChannelTypes(0,5).setRequired(false)),  
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);

  // Important: if old global commands exist (previous versions), Discord clients may show
  // “commande obsolèteâ€ for a while.
  // NOTE: do NOT clear global commands on every startup (can cause missing commands / long propagation).
  // If you need a reset, do it manually once.


  // Always register guild commands when possible (fast propagation)
  if (!config.guildId) throw new Error('GUILD_ID is required for fast slash command propagation');

  console.log('[bot] registering guild commands...', { guildId: config.guildId, count: commands.length });
  try {
    const out = await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
    console.log('[bot] guild commands registered:', Array.isArray(out) ? out.length : 'ok');
  } catch (e) {
    console.error('[bot] command registration failed:', e?.message || e, e?.rawError || '');
    throw e;
  }
}

async function main() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
  });

  client.once('ready', async () => {
    try {
      await registerCommands(client);

      const guild = config.guildId ? await client.guilds.fetch(config.guildId) : null;

      if (guild && config.defaultChannelId) {
        const channel = await client.channels.fetch(config.defaultChannelId);

        // Seed first button if not present (legacy)
        panel.upsertGuildButton(guild.id, config.defaultChannelId, {
          name: 'GTO',
          roleId: '1480657602382790902',
          label: 'GTO',
          sortOrder: 0,
        });

        const rc = getConfigForGuild(guild.id);
        await ensurePanelMessage(channel, rc);
      }

      // Scoreboard message in dedicated channel (only if configured)
      let scoreboardChannel = null;
      if (guild) {
        const rc0 = getConfigForGuild(guild.id);
        if (rc0.scoreboardChannelId && rc0.guildeuxRoleId) {
          scoreboardChannel = await client.channels.fetch(rc0.scoreboardChannelId).catch(() => null);
          if (scoreboardChannel && scoreboardChannel.isTextBased()) {
            await scoreboard.ensureScoreboardMessage(guild, scoreboardChannel, { topN: rc0.scoreboardTopN });
          } else {
            console.warn('[bot] scoreboard channel not accessible:', rc0.scoreboardChannelId);
          }

          // Weekly announcement scheduler (checks every 30s)
          setInterval(async () => {
            try {
              if (scoreboardChannel && scoreboardChannel.isTextBased()) {
                await scoreboard.maybeWeeklyAnnouncement(guild, scoreboardChannel, { topN: 10, hour: 22 });

                // Almanax daily post @ 00:00 Europe/Paris
                try {
                  const rcA = getConfigForGuild(guild.id);
                  await maybeDailyAlmanax(guild, rcA);
                } catch (e2) {
                  console.warn('[bot] almanax daily failed:', e2?.message || e2);
                }
              }
            } catch (e) {
              console.warn('[bot] weekly announcement error:', e?.message || e);
            }
          }, 30_000);
        } else {
          console.warn('[bot] scoreboard disabled (missing config in DB)');
        }
      }

      console.log('[bot] ready');

      // Validate def role mentionability (if configured)
      const me = client.user;
      const rc0 = guild ? getConfigForGuild(guild.id) : null;
      if (guild && rc0?.defRoleId) {
        const perm = canPingRole(guild, me, rc0.defRoleId);
        if (!perm.ok) console.warn('[bot] DEF role ping may fail:', perm.reason);
      }

      // Help/commands box (staff guide)
      if (guild && rc0?.helpChannelId) {
        await ensureHelpMessage(guild, rc0);
      }

      // Preload invite cache for surveillance
      if (guild) {
        await refreshInvites(guild);
      }
    } catch (e) {
      console.error('[bot] ready error', e);
    }
  });

  // On join: guide the user to the rules channel/message (Discord can't "auto-redirect" a user).
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot) return;
      const rc = getConfigForGuild(message.guild.id);
      if (!rc.eventProofsChannelId) return;

      // We accept proofs in threads under the proofs channel
      const isThread = message.channel?.isThread?.();
      const parentId = isThread ? message.channel.parentId : null;
      if (!isThread || parentId !== rc.eventProofsChannelId) return;

      const draft = drafts.getDraft(message.guild.id, message.author.id);
      if (!draft || draft.thread_id !== message.channelId) return;

      // Stage 1: participants message (no images)
      if (draft.stage === 'need_participants') {
        const ids = [...message.mentions.users.keys()];
        if (!ids.length) {
          await message.reply({ content: '⚠️ Mentionne au moins 1 participant (@personne).', allowedMentions: { users: [message.author.id] } }).catch(() => {});
          return;
        }
        const participantsText = ids.join(',');
        drafts.setParticipants(message.guild.id, message.author.id, participantsText);
        drafts.setStage(message.guild.id, message.author.id, 'need_images');
        await message.reply({ content: '✅ Participants enregistrés. **Étape 2/2 :** envoie maintenant **1 ou 2 screenshots** (date/heure visibles).', allowedMentions: { users: [message.author.id] } }).catch(() => {});
        return;
      }

      // Stage 2: images
      const atts = [...message.attachments.values()].filter(a => (a.contentType || '').startsWith('image/'));
      if (atts.length < 1) return;
      if (atts.length > 2) {
        await message.reply({ content: '⚠️ Maximum **2 images** par combat.', allowedMentions: { users: [message.author.id] } }).catch(() => {});
        return;
      }

      const participantsText = String(draft.participants || '');
      const participantIds = participantsText.split(',').map(s => s.trim()).filter(Boolean);

      // Acknowledge in the thread (pending)
      const pendingEmbed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('🟡 En attente de confirmation')
        .setDescription('Ton combat a été envoyé au staff pour validation.\nEn cas de refus, tu seras ping avec la raison.')
        .addFields({
          name: 'Participants',
          value: participantIds.length ? participantIds.map(id => `<@${id}>`).join(' ') : '⚠️ Aucun participant',
          inline: false,
        })
        .setTimestamp();

      const pendingMsg = await message.reply({ embeds: [pendingEmbed], allowedMentions: { users: [message.author.id] } }).catch(() => null);

      const sid = ev.createSubmission({
        guildId: message.guild.id,
        authorId: message.author.id,
        participants: participantsText,
        proofsChannelId: message.channelId,
        proofsMessageId: message.id,
        pendingReplyMessageId: pendingMsg?.id || null,
      });

      // Download + reupload attachments to staff ticket
      const files = [];
      for (let i = 0; i < atts.length; i++) {
        const a = atts[i];
        try {
          const resp = await fetch(a.url);
          if (!resp.ok) continue;
          const buf = Buffer.from(await resp.arrayBuffer());
          files.push({ attachment: buf, name: `preuve-${i + 1}.png` });
        } catch {}
      }

      // Staff ticket
      if (rc.eventValidationChannelId) {
        const vch = await message.client.channels.fetch(rc.eventValidationChannelId).catch(() => null);
        if (vch && vch.isTextBased()) {
          // 1) Staff proof message (embeds + files only). Some Discord clients hide components on heavy messages.
          const ignLines = participantIds
            .map(uid => {
              const p = profiles.getProfile(message.guild.id, uid);
              const ign = String(p?.ign || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
              if (!ign.length) return null;
              return `<@${uid}> : ${ign.map(x => `**${x}**`).join(', ')}`;
            })
            .filter(Boolean);

          const staffEmbed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('🧾 Validation événement perco')
            .setDescription(`[Voir la preuve](${message.url})`)
            .addFields(
              { name: 'Auteur', value: `${message.author} (\`${message.author.id}\`)`, inline: false },
              { name: 'Participants (déclarés)', value: participantIds.length ? participantIds.map(id => `<@${id}>`).join(' ') : '⚠️ Aucun', inline: false },
              ignLines.length
                ? { name: '🎮 Pseudos en jeu (profil)', value: ignLines.join('\n').slice(0, 1024), inline: false }
                : { name: '🎮 Pseudos en jeu (profil)', value: '_Aucun pseudo enregistré pour ces joueurs._', inline: false },
              { name: 'Règle points', value: 'Points / joueur = nombre de défenseurs présents (perco inclus).', inline: false },
            )
            .setFooter({ text: `SID ${sid}` })
            .setTimestamp();

          // Controls directly on the proof message (single message, less noise)
          const select = new StringSelectMenuBuilder()
            .setCustomId(`evdef:${sid}`)
            .setPlaceholder('Défenseurs présents (perco inclus)')
            .addOptions(
              { label: '1', value: '1' },
              { label: '2', value: '2' },
              { label: '3', value: '3' },
              { label: '4', value: '4' },
              { label: '5', value: '5' },
            );

          const row1 = new ActionRowBuilder().addComponents(select);
          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`evval:${sid}:approve`).setLabel('✅ Valider').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`evval:${sid}:deny`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`evval:${sid}:editparts`).setLabel('✏️ Participants').setStyle(ButtonStyle.Secondary),
          );

          const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`evpub:${sid}:add`).setLabel('➕ Points').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`evpub:${sid}:set`).setLabel('✏️ Fixer points').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`evpub:${sid}:remove`).setLabel('🧹 Kick').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`evpub:${sid}:resync`).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary),
          );

          const staffMsg = await vch.send({ embeds: [staffEmbed], components: [row1, row2, row3], files, allowedMentions: { parse: [] } });
          ev.setStaffMessageId(sid, staffMsg.id);
        }
      }

      // Draft consumed
      drafts.clearDraft(message.guild.id, message.author.id);

    } catch (e) {
      console.warn('[bot] event proofs handler error:', e?.message || e);
    }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      const rc = getConfigForGuild(member.guild.id);

      // Surveillance log (who invited)
      try {
        const before = inviteCache.get(member.guild.id);
        await refreshInvites(member.guild);
        const after = inviteCache.get(member.guild.id);
        let used = null;
        if (before && after) {
          for (const [code, inv] of after.entries()) {
            const prev = before.get(code);
            if (prev && inv.uses > prev.uses) {
              used = inv;
              break;
            }
          }
        }

        const avatar = member.user.displayAvatarURL?.({ size: 256 });

        const embed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Arrivée sur le serveur')
          .setThumbnail(avatar)
          .addFields(
            { name: 'Membre', value: `${member} (\`${member.id}\`)`, inline: false },
            { name: 'Compte', value: member.user.tag || member.user.username, inline: true },
            { name: 'Créé le', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Arrivé', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
            {
              name: 'Invité par',
              value: used?.inviter ? `${used.inviter} (code: \`${used.code}\`, uses: **${used.uses}**)` : 'Inconnu (permissions/intent invites manquants)',
              inline: false,
            },
          )
          .setFooter({ text: 'Surveillance (join/invite) — no ping' })
          .setTimestamp();

        await sendSurveillance(member.guild, rc, embed);
      } catch {}

      // Rules prompt
      if (rc.rulesChannelId) {
        const ch = await member.client.channels.fetch(rc.rulesChannelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const content = `${member} bienvenue ! Lis le règlement ci-dessus, puis valide en cliquant sur le bouton ci-dessous.`;
          const components = buildRulesAcceptComponents(member.guild.id, member.user.id);
          const prompt = await ch.send({ content, components, allowedMentions: { users: [member.id] } });
          setTimeout(() => prompt.delete().catch(() => {}), 120_000);
        }
      }
    } catch (e) {
      console.warn('[bot] join handler error:', e?.message || e);
    }
  });

  client.on('messageDelete', async (message) => {
    try {
      if (!message.guild) return;
      const rc = getConfigForGuild(message.guild.id);

      const author = message.author ? `${message.author.tag || message.author.username} (\`${message.author.id}\`)` : 'Inconnu (partial)';
      const actor = await getAuditActor(message.guild, { type: 72, targetId: message.author?.id || null }); // MESSAGE_DELETE

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('🗑️ Message supprimé')
        .addFields(
          { name: 'Auteur', value: author, inline: false },
          { name: 'Supprimé par', value: actor?.executor ? `${actor.executor} (audit log)` : 'Inconnu / auteur', inline: false },
          { name: 'Salon', value: message.channelId ? `<#${message.channelId}>` : '—', inline: true },
          { name: 'Message ID', value: `\`${message.id}\``, inline: true },
        )
        .setTimestamp();

      await sendActivityLog(message.guild, rc, embed);
    } catch {}
  });

  client.on('messageDeleteBulk', async (messages) => {
    try {
      const first = messages.first();
      if (!first?.guild) return;
      const rc = getConfigForGuild(first.guild.id);

      // Best-effort actor detection (often a mod or bot)
      const actor = await getAuditActor(first.guild, { type: 73, windowMs: 20_000 }); // MESSAGE_BULK_DELETE

      const embed = new EmbedBuilder()
        .setColor(0xd35400)
        .setTitle('🧹 Suppression en masse')
        .addFields(
          { name: 'Nombre', value: String(messages.size), inline: true },
          { name: 'Salon', value: first.channelId ? `<#${first.channelId}>` : '—', inline: true },
          { name: 'Par', value: actor?.executor ? `${actor.executor} (audit log)` : 'Inconnu', inline: false },
        )
        .setTimestamp();

      await sendActivityLog(first.guild, rc, embed);
    } catch {}
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
      if (!newMessage.guild) return;
      const rc = getConfigForGuild(newMessage.guild.id);

      const author = newMessage.author ? `${newMessage.author.tag || newMessage.author.username} (\`${newMessage.author.id}\`)` : 'Inconnu (partial)';
      const before = (oldMessage?.content || '').slice(0, 400);
      const after = (newMessage?.content || '').slice(0, 400);

      // Skip noisy updates (embeds/pins) where content didn't change
      if (before === after) return;

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('✏️ Message modifié')
        .addFields(
          { name: 'Auteur', value: author, inline: false },
          { name: 'Salon', value: newMessage.channelId ? `<#${newMessage.channelId}>` : '—', inline: true },
          { name: 'Message ID', value: `\`${newMessage.id}\``, inline: true },
          { name: 'Avant', value: before ? `\`${before}\`` : '(contenu non dispo)', inline: false },
          { name: 'Après', value: after ? `\`${after}\`` : '(contenu non dispo)', inline: false },
        )
        .setTimestamp();

      await sendActivityLog(newMessage.guild, rc, embed);
    } catch {}
  });

  client.on('roleUpdate', async (oldRole, newRole) => {
    try {
      if (!newRole.guild) return;
      const rc = getConfigForGuild(newRole.guild.id);
      const actor = await getAuditActor(newRole.guild, { type: 31, targetId: newRole.id, windowMs: 20_000 }); // ROLE_UPDATE

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🧩 Rôle modifié')
        .addFields(
          { name: 'Rôle', value: `${newRole} (\`${newRole.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(newRole.guild, rc, embed);
    } catch {}
  });

  client.on('channelCreate', async (channel) => {
    try {
      if (!channel.guild) return;
      const rc = getConfigForGuild(channel.guild.id);
      const actor = await getAuditActor(channel.guild, { type: 10, targetId: channel.id, windowMs: 20_000 }); // CHANNEL_CREATE
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📁 Salon créé')
        .addFields(
          { name: 'Salon', value: `<#${channel.id}> (\`${channel.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(channel.guild, rc, embed);
    } catch {}
  });

  client.on('channelDelete', async (channel) => {
    try {
      if (!channel.guild) return;
      const rc = getConfigForGuild(channel.guild.id);
      const actor = await getAuditActor(channel.guild, { type: 12, targetId: channel.id, windowMs: 20_000 }); // CHANNEL_DELETE
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🗑️ Salon supprimé')
        .addFields(
          { name: 'Salon', value: `#${channel.name} (\`${channel.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(channel.guild, rc, embed);
    } catch {}
  });

  client.on('channelUpdate', async (oldCh, newCh) => {
    try {
      if (!newCh.guild) return;
      const rc = getConfigForGuild(newCh.guild.id);
      if (oldCh.name === newCh.name) return;
      const actor = await getAuditActor(newCh.guild, { type: 11, targetId: newCh.id, windowMs: 20_000 }); // CHANNEL_UPDATE
      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle('✏️ Salon renommé')
        .addFields(
          { name: 'Avant', value: String(oldCh.name), inline: true },
          { name: 'Après', value: String(newCh.name), inline: true },
          { name: 'Salon', value: `<#${newCh.id}> (\`${newCh.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(newCh.guild, rc, embed);
    } catch {}
  });

  client.on('guildBanAdd', async (ban) => {
    try {
      const guild = ban.guild;
      const rc = getConfigForGuild(guild.id);
      const actor = await getAuditActor(guild, { type: 22, targetId: ban.user.id, windowMs: 30_000 }); // MEMBER_BAN_ADD
      const embed = new EmbedBuilder()
        .setColor(0xc0392b)
        .setTitle('⚔️ Ban')
        .addFields(
          { name: 'Membre', value: `${ban.user.tag} (\`${ban.user.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(guild, rc, embed);
    } catch {}
  });

  client.on('guildBanRemove', async (ban) => {
    try {
      const guild = ban.guild;
      const rc = getConfigForGuild(guild.id);
      const actor = await getAuditActor(guild, { type: 23, targetId: ban.user.id, windowMs: 30_000 }); // MEMBER_BAN_REMOVE
      const embed = new EmbedBuilder()
        .setColor(0x27ae60)
        .setTitle('✅ Unban')
        .addFields(
          { name: 'Membre', value: `${ban.user.tag} (\`${ban.user.id}\`)`, inline: false },
          { name: 'Par', value: actor?.executor ? `${actor.executor}` : 'Inconnu', inline: false },
        )
        .setTimestamp();
      await sendActivityLog(guild, rc, embed);
    } catch {}
  });

  client.on('guildMemberRemove', async (member) => { 
    // Surveillance + cleanup profiles when someone leaves / is kicked
    try {
      const rc = getConfigForGuild(member.guild.id);
      const userId = member?.user?.id || member?.id;
      console.log('[surveillance] guildMemberRemove', { guildId: member.guild.id, userId });

      // Determine leave vs kick (best effort: audit log)
      let kickedBy = null;
      try {
        if (member.guild.members.me.permissions.has(PermissionsBitField.Flags.ViewAuditLog)) {
          const logs = await member.guild.fetchAuditLogs({ limit: 5, type: 20 }); // MEMBER_KICK
          const entry = logs.entries.find(e => e.target?.id === member.id && Date.now() - e.createdTimestamp < 60_000);
          if (entry) kickedBy = entry.executor;
        }
      } catch {}

      const embed = new EmbedBuilder()
        .setColor(kickedBy ? 0xe74c3c : 0x95a5a6)
        .setTitle(kickedBy ? '⚔️ Membre expulsé' : '🚪 Membre parti')
        .addFields(
          { name: 'Membre', value: `<@${userId}> (\`${userId}\`)`, inline: false },
          { name: 'Action', value: kickedBy ? `Kick par ${kickedBy}` : 'Départ volontaire', inline: false },
        )
        .setTimestamp();
      await sendSurveillance(member.guild, rc, embed);

      // Cleanup profile + delete profile box
      const existing = userId ? profiles.deleteProfile(member.guild.id, userId) : null;
      if (rc.profilesChannelId && existing?.profile_message_id) {
        const ch = await member.client.channels.fetch(rc.profilesChannelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          await ch.messages.delete(existing.profile_message_id).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('[bot] memberRemove error:', e?.message || e);
    }
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
      // If someone gains the guildeux role, ensure they're listed (0 score) and refresh board
      const rc = getConfigForGuild(newMember.guild.id);
      if (!rc.guildeuxRoleId || !rc.scoreboardChannelId) return;

      const gained = !oldMember.roles.cache.has(rc.guildeuxRoleId) && newMember.roles.cache.has(rc.guildeuxRoleId);
      if (!gained) return;

      scoreboard.upsertScoreUser(newMember.guild.id, newMember.user.id);
      const sbChannel = await newMember.client.channels.fetch(rc.scoreboardChannelId).catch(() => null);
      if (sbChannel && sbChannel.isTextBased()) {
        await scoreboard.ensureScoreboardMessage(newMember.guild, sbChannel, { topN: rc.scoreboardTopN });
      }
    } catch (e) {
      console.warn('[bot] guildMemberUpdate scoreboard error:', e?.message || e);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // Message context menu: DeepL translation (ephemeral)
      if (interaction.isMessageContextMenuCommand && interaction.isMessageContextMenuCommand()) {
        const name = interaction.commandName;
        const map = {
          'Traduire FR': 'FR',
          'Translate EN': 'EN-GB',
          'Traducir ES': 'ES',
        };
        const target = map[name];
        if (target) {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const msg = interaction.targetMessage;
          const extractFromEmbed = (emb) => {
            if (!emb) return '';
            const parts = [];
            if (emb.title) parts.push(String(emb.title));
            if (emb.description) parts.push(String(emb.description));
            if (Array.isArray(emb.fields)) {
              for (const f of emb.fields) {
                if (f?.name) parts.push(String(f.name));
                if (f?.value) parts.push(String(f.value));
              }
            }
            return parts.join('\n');
          };

          const rawText =
            (msg?.content && String(msg.content).trim()) ||
            extractFromEmbed(msg?.embeds?.[0]) ||
            '';

          const text = rawText
            .replace(/<@&?\d+>/g, '') // remove mentions
            .replace(/<#[0-9]+>/g, '')
            .replace(/<:[^:]+:\d+>/g, '')
            .replace(/<a:[^:]+:\d+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();

          if (!text) {
            return interaction.editReply({ content: '❌ Rien à traduire sur ce message (texte vide).' }).catch(() => {});
          }

          const limited = text.slice(0, 1500);

          try {
            const translated = await withDeeplThrottle(interaction.user.id, () => deeplTranslate(limited, target));

            const embed = new EmbedBuilder()
              .setColor(0x1abc9c)
              .setTitle('🌍 Traduction')
              .addFields(
                { name: 'Résultat', value: String(translated).slice(0, 3900) || '—', inline: false },
              )
              .setFooter({ text: `DeepL • cible ${target}` });

            return interaction.editReply({ embeds: [embed] }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `❌ Erreur traduction: ${(e?.message || e)}`.slice(0, 1800) }).catch(() => {});
          }
        }
      }

      // Event validation select
      if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
        // Stuff generator selects
        if (interaction.customId.startsWith('gs:')) {
          if (interaction.channelId !== STUFF_GEN_CHANNEL_ID) {
            return interaction.reply({ content: `Utilise le générateur uniquement dans <#${STUFF_GEN_CHANNEL_ID}>.`, ephemeral: true });
          }

          const [_, kind, sessionId] = interaction.customId.split(':');
          const state = stuffSessions.get(sessionId);
          if (!state) {
            return interaction.reply({ content: 'Session expirée. Demande à un admin de relancer /generateurstuff.', ephemeral: true });
          }

          const value = interaction.values?.[0];
          if (kind === 'elem') state.criteria.element = value;
          if (kind === 'pa') state.criteria.pa = value;
          if (kind === 'pm') state.criteria.pm = value;

          const components = stuffGen.buildUI(sessionId, state.criteria, { regenLabel: 'Générer' });
          return interaction.update({
            content: [
              '**Générateur de stuff — Dashboard**',
              `Sélection: element=${state.criteria.element || '—'} | PA=${state.criteria.pa || '—'} | PM=${state.criteria.pm || '—'}`,
              'Clique sur **Générer** pour recevoir 10 liens en privé (éphémère).',
            ].join('\n'),
            components,
          });
        }

        if (interaction.customId.startsWith('evdef:')) {
          const id = Number(interaction.customId.split(':')[1]);
          const defenders = Number(interaction.values?.[0]);
          if (!Number.isFinite(id) || !Number.isFinite(defenders)) {
            return interaction.reply({ content: 'Valeur invalide.', ephemeral: true });
          }
          // staff only
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          ev.setDefendersPresent(id, defenders);
          return interaction.reply({ content: `OK. Défenseurs présents = ${defenders} (points par joueur).`, ephemeral: true });
        }
      }

      // Activity log: slash commands usage (no pings)
      if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        // Avoid logging the logger setup itself before it exists
        if (interaction.commandName !== 'setup_activity_logs') {
          const rc = getConfigForGuild(interaction.guildId);
          const opts = interaction.options?.data
            ? interaction.options.data.map(o => `${o.name}=${o.value ?? '[obj]'}`).join(' ')
            : '';
          const embed = new EmbedBuilder()
            .setColor(0x8e44ad)
            .setTitle('⌨️ Commande exécutée')
            .addFields(
              { name: 'Commande', value: `/${interaction.commandName} ${opts}`.trim().slice(0, 1024), inline: false },
              { name: 'Par', value: `${interaction.user.tag || interaction.user.username} (\`${interaction.user.id}\`)`, inline: true },
              { name: 'Salon', value: interaction.channelId ? `<#${interaction.channelId}>` : '—', inline: true },
            )
            .setTimestamp();
          await sendActivityLog(interaction.guild, rc, embed);
        }
      }
      // Modal: collect in-game name (IGN)
      if (interaction.isModalSubmit && interaction.isModalSubmit()) {

        if (interaction.customId.startsWith('dbp:add_submit:')) {
          const guildId = interaction.customId.split(':')[2];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member || !isGtoOrDefMember(member, rc)) {
            return interaction.reply({ content: 'Réservé aux membres **GTO/DEF**.', ephemeral: true });
          }

          const draft = getDraft(guildId, interaction.user.id);
          if (!draft.classKey || !draft.elementKey) {
            return interaction.reply({ content: '❌ Choisis d\'abord une **classe** et un **élément** dans le panneau.', ephemeral: true });
          }

          const buildName = (interaction.fields.getTextInputValue('name') || '').trim();
          const levelRaw = (interaction.fields.getTextInputValue('level') || '').trim();
          const urlRaw = (interaction.fields.getTextInputValue('url') || '').trim();

          const level = Number(levelRaw);
          if (!Number.isFinite(level) || level < 1 || level > 200) {
            return interaction.reply({ content: '❌ Niveau invalide (1-200).', ephemeral: true });
          }

          const url = sanitizeDofusbookUrl(urlRaw);
          if (!url) {
            return interaction.reply({ content: '❌ Lien invalide. Donne un lien **dofusbook** (http/https).', ephemeral: true });
          }

          if (!buildName || buildName.length < 2) {
            return interaction.reply({ content: '❌ Nom de build invalide.', ephemeral: true });
          }

          db.prepare('INSERT INTO dofusbook_builds (guild_id, user_id, class_key, element_key, level, build_name, url, created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(guildId, interaction.user.id, draft.classKey, draft.elementKey, level, buildName.slice(0, 80), url, Date.now());

          // refresh panel
          try {
            const rc2 = getConfigForGuild(guildId);
            if (rc2.dofusbookPanelChannelId) {
              const ch = await interaction.client.channels.fetch(rc2.dofusbookPanelChannelId).catch(() => null);
              if (ch && ch.isTextBased()) {
                await ensureDofusbookPanel(interaction.guild, ch, rc2);
              }
            }
          } catch {}

          return interaction.reply({ content: '✅ Build ajouté au panneau.', ephemeral: true });
        }

        // Métiers modal
        if (interaction.customId.startsWith('mj:add_level:')) {
          const parts = interaction.customId.split(':');
          const jobKey = parts[2];
          const jobLabel = parts.slice(3).join(':') || jobKey;

          const lvlRaw = interaction.fields.getTextInputValue('level');
          const lvl = metiers.clampInt(lvlRaw, 1, 100);
          if (!lvl) return interaction.reply({ content: 'Niveau invalide (1 à 100).', ephemeral: true });

          const db2 = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          if (!db2.users) db2.users = {};
          const prev = db2.users[interaction.user.id] || {};
          const jobs = Array.isArray(prev.jobs) ? prev.jobs : [];

          const catalog = metiers.getJobsCatalog();
          const hit = catalog.find((j) => j.key === jobKey);
          const category = hit?.category || null;

          const idx = jobs.findIndex((j) => j.key === jobKey);
          const next = { key: jobKey, label: jobLabel, level: lvl, category };
          if (idx >= 0) jobs[idx] = next;
          else jobs.push(next);

          db2.users[interaction.user.id] = { jobs, messageId: prev.messageId || null, updatedAt: new Date().toISOString() };
          metiers.writeJsonAtomic(metiers.JOBS_USERS_PATH, db2);

          // Update public fiche in dedicated channel
          const ch = await interaction.client.channels.fetch(metiers.CHANNEL_FICHES_PUBLIC).catch(() => null);
          if (ch && ch.isTextBased()) {
            const embed = await metiers.buildUserJobsEmbed(interaction.user, jobs, { updatedAt: db2.users[interaction.user.id].updatedAt });
            let msg = null;
            if (prev.messageId) {
              msg = await ch.messages.fetch(prev.messageId).catch(() => null);
              if (msg) msg = await msg.edit({ embeds: [embed], components: metiers.buildPublicFicheButtons(interaction.user.id) }).catch(() => null);
            }
            if (!msg) {
              msg = await ch.send({ embeds: [embed], components: metiers.buildPublicFicheButtons(interaction.user.id) }).catch(() => null);
            }
            if (msg) {
              db2.users[interaction.user.id].messageId = msg.id;
              metiers.writeJsonAtomic(metiers.JOBS_USERS_PATH, db2);
            }
          }

          return interaction.reply({ content: `✅ ${jobLabel} niveau ${lvl} enregistré.`, ephemeral: true });
        }

        if (interaction.customId.startsWith('ankprof:submit:')) {
          const guildId = interaction.customId.split(':')[2];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          if (rc.ankamaProfileChannelId && interaction.channelId !== rc.ankamaProfileChannelId) {
            return interaction.reply({ content: `Utilise ce panneau uniquement dans <#${rc.ankamaProfileChannelId}>.`, ephemeral: true });
          }

          const input = (interaction.fields.getTextInputValue('tag') || '').trim();
          const slug = ankamaTagToSlug(input);
          if (!slug) {
            return interaction.reply({
              content: "❌ Format invalide. Attendu: **pseudo#1234** (ex: `MonPseudo#6715`).",
              ephemeral: true,
            });
          }

          const url = `https://account.ankama.com/fr/profil-ankama/${encodeURIComponent(slug)}`;

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('🔗 Ouvrir le profil')
          );

          return interaction.reply({
            content: `Voici le profil Ankama demandé : <${url}>`,
            components: [row],
            ephemeral: true,
          });
        }

        if (interaction.customId.startsWith('evparts:')) { 
          const id = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const raw = (interaction.fields.getTextInputValue('participants') || '').trim();
          const ids = raw
            .match(/\d{17,20}/g)
            ?.map(s => s.trim())
            .filter(Boolean) || [];
          const uniq = [...new Set(ids)];
          ev.setParticipantsOverride(id, uniq.join(','));
          return interaction.reply({ content: `✅ Participants mis à jour (${uniq.length}).`, ephemeral: true });
        }

        if (interaction.customId.startsWith('evdeny:')) {
          const id = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const reason = (interaction.fields.getTextInputValue('reason') || '').trim();
          const sub = ev.getSubmission(id);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          if (sub.status !== 'pending') {
            return interaction.reply({ content: 'Déjà traité.', ephemeral: true });
          }

          ev.markDenied(id, { validatedBy: interaction.user.id, reason });

          // Post official result + close thread (lock+archive)
          try {
            const baseList = String(sub.participants_override || sub.participants || '');
            const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
            await postOfficialEventResult(interaction.guild, rc, sub, {
              status: 'denied',
              defenders: null,
              participantIds,
              validatedBy: interaction.user.id,
              reason,
            }).catch(() => {});

            await postEventScreen(interaction.guild, rc, sub, {
              status: 'denied',
              defenders: null,
              participantIds,
              validatedBy: interaction.user.id,
              reason,
            }).catch(() => {});

            await closeEventThread(interaction.guild, sub).catch(() => {});
          } catch {}

          // Update pending reply
          try {
            const proofsCh = await interaction.client.channels.fetch(sub.proofs_channel_id).catch(() => null);
            if (proofsCh && proofsCh.isTextBased() && sub.pending_reply_message_id) {
              const msg = await proofsCh.messages.fetch(sub.pending_reply_message_id).catch(() => null);
              if (msg) {
                const embed = new EmbedBuilder()
                  .setColor(0xe74c3c)
                  .setTitle('❌ Refusé')
                  .setDescription(`Refusé par <@${interaction.user.id}>`)
                  .addFields({ name: 'Raison', value: reason.slice(0, 1024), inline: false })
                  .setTimestamp();
                await msg.edit({ embeds: [embed] }).catch(() => {});
              }
            }

            // Ping player with reason on original message
            if (proofsCh && proofsCh.isTextBased()) {
              const original = await proofsCh.messages.fetch(sub.proofs_message_id).catch(() => null);
              if (original) {
                await original.reply({
                  content: `<@${sub.author_id}> ❌ Preuve refusée.\n**Raison :** ${reason}`,
                  allowedMentions: { users: [sub.author_id] },
                }).catch(() => {});
              }
            }
          } catch {}

          // Remove staff components
          try { await interaction.message.edit({ components: [] }); } catch {}

          return interaction.reply({ content: '❌ Refus enregistré et envoyé au joueur.', ephemeral: true });
        }

        // Events Perco — per-publication modals
        if (interaction.customId.startsWith('evpub_add_submit:')) {
          const sid = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          const delta = Number((interaction.fields.getTextInputValue('delta') || '').trim());
          if (!Number.isFinite(delta)) return interaction.reply({ content: 'Delta invalide.', ephemeral: true });

          const baseList = String(sub.participants_override || sub.participants || '');
          const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
          if (!participantIds.length) return interaction.reply({ content: 'Aucun participant.', ephemeral: true });

          for (const uid of participantIds) ev.addPoints(interaction.guildId, uid, delta);
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `✅ OK. ${delta >= 0 ? '+' : ''}${delta} pts appliqués à ${participantIds.length} joueur(s).`, ephemeral: true });
        }

        if (interaction.customId.startsWith('evpub_set_submit:')) {
          const sid = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          const points = Number((interaction.fields.getTextInputValue('points') || '').trim());
          if (!Number.isFinite(points) || points < 0) return interaction.reply({ content: 'Points invalides.', ephemeral: true });

          const baseList = String(sub.participants_override || sub.participants || '');
          const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
          if (!participantIds.length) return interaction.reply({ content: 'Aucun participant.', ephemeral: true });

          for (const uid of participantIds) ev.setPoints(interaction.guildId, uid, Math.floor(points));
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `✅ OK. Points fixés à ${Math.floor(points)} pour ${participantIds.length} joueur(s) (ce combat).`, ephemeral: true });
        }

        if (interaction.customId.startsWith('evpub_remove_submit:')) {
          const sid = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          const rawUser = (interaction.fields.getTextInputValue('user') || '').trim();
          const userId = (rawUser.match(/\d{17,20}/) || [null])[0];
          if (!userId) return interaction.reply({ content: 'User invalide.', ephemeral: true });

          ev.removeUser(interaction.guildId, userId);
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `🧹 OK. <@${userId}> retiré du classement.`, ephemeral: true, allowedMentions: { parse: [] } });
        }

        // Events Perco — correction modal submit (preview only)
        if (interaction.customId.startsWith('evfix_submit:')) {
          const sid = Number(interaction.customId.split(':')[1]);
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
          if (sub.status !== 'approved') return interaction.reply({ content: 'Correction possible uniquement après validation.', ephemeral: true });

          const defenders = Number((interaction.fields.getTextInputValue('defenders') || '').trim());
          if (!defenders || defenders < 1 || defenders > 5) return interaction.reply({ content: 'Défenseurs invalides (1-5).', ephemeral: true });

          const raw = (interaction.fields.getTextInputValue('participants') || '').trim();
          const ids = raw.match(/\d{17,20}/g)?.map(s => s.trim()).filter(Boolean) || [];
          const participantIds = [...new Set(ids)];
          if (!participantIds.length) return interaction.reply({ content: 'Aucun participant.', ephemeral: true });

          // Compute delta preview from current awards
          const oldAwards = ev.listAwards(interaction.guildId, sid);
          const oldMap = new Map(oldAwards.map(r => [r.user_id, Number(r.points || 0)]));

          const newMap = new Map();
          for (const uid of participantIds) newMap.set(uid, defenders);

          const affected = new Set([...oldMap.keys(), ...newMap.keys()]);
          const lines = [];
          for (const uid of affected) {
            const before = oldMap.get(uid) || 0;
            const after = newMap.get(uid) || 0;
            const delta = after - before;
            if (delta !== 0) lines.push(`<@${uid}> : ${before} â†’ ${after} (**${delta > 0 ? '+' : ''}${delta}**)`);
          }

          pendingEventFix.set(`${interaction.user.id}:${sid}`, { participantIds, defenders });

          const embed = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('🧮 Prévisualisation — Correction')
            .setDescription(
              `SID **${sid}**\n` +
              `Nouveau points/joueur: **${defenders}**\n` +
              `Participants: ${participantIds.map(u => `<@${u}>`).join(' ')}`
            )
            .addFields({ name: 'Impact', value: lines.join('\n').slice(0, 1024) || 'Aucun changement.', inline: false })
            .setFooter({ text: 'Clique sur ✅ Appliquer correction pour confirmer.' });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`evfixapply:${sid}:apply`).setLabel('✅ Appliquer correction').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`evfixapply:${sid}:cancel`).setLabel('❌ Annuler').setStyle(ButtonStyle.Secondary),
          );

          return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        // Events Perco — staff admin modals
        if (interaction.customId === 'evadm_add_submit') {
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const rawUser = (interaction.fields.getTextInputValue('user') || '').trim();
          const rawDelta = (interaction.fields.getTextInputValue('delta') || '').trim();
          const userId = (rawUser.match(/\d{17,20}/) || [null])[0];
          const delta = Number(rawDelta);
          if (!userId || !Number.isFinite(delta)) return interaction.reply({ content: 'Valeurs invalides.', ephemeral: true });

          ev.addPoints(interaction.guildId, userId, delta);
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `✅ OK. <@${userId}> ${delta >= 0 ? '+' : ''}${delta} pts.`, ephemeral: true, allowedMentions: { parse: [] } });
        }

        if (interaction.customId === 'evadm_set_submit') {
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const rawUser = (interaction.fields.getTextInputValue('user') || '').trim();
          const rawPoints = (interaction.fields.getTextInputValue('points') || '').trim();
          const userId = (rawUser.match(/\d{17,20}/) || [null])[0];
          const points = Number(rawPoints);
          if (!userId || !Number.isFinite(points) || points < 0) return interaction.reply({ content: 'Valeurs invalides.', ephemeral: true });

          ev.setPoints(interaction.guildId, userId, Math.floor(points));
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `✅ OK. <@${userId}> = ${Math.floor(points)} pts.`, ephemeral: true, allowedMentions: { parse: [] } });
        }

        if (interaction.customId === 'evadm_remove_submit') {
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const rawUser = (interaction.fields.getTextInputValue('user') || '').trim();
          const userId = (rawUser.match(/\d{17,20}/) || [null])[0];
          if (!userId) return interaction.reply({ content: 'User invalide.', ephemeral: true });

          ev.removeUser(interaction.guildId, userId);
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});
          return interaction.reply({ content: `🧹 OK. <@${userId}> supprimé du classement.`, ephemeral: true, allowedMentions: { parse: [] } });
        }

        if (interaction.customId === 'evadm_reset_submit') {
          const rc = getConfigForGuild(interaction.guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const confirm = (interaction.fields.getTextInputValue('confirm') || '').trim().toUpperCase();
          if (confirm !== 'RESET') {
            return interaction.reply({ content: 'Reset annulé (tu dois taper RESET).', ephemeral: true });
          }

          // Collect messages to delete
          const rows = ev.listSubmissionsForReset(interaction.guildId);

          // Delete screens
          if (rc.eventScreensChannelId) {
            const sch = await interaction.client.channels.fetch(rc.eventScreensChannelId).catch(() => null);
            if (sch && sch.isTextBased()) {
              for (const r of rows) {
                if (!r.screen_message_id) continue;
                await sch.messages.delete(r.screen_message_id).catch(() => {});
              }
            }
          }

          // Delete staff validation messages (proof + controls) in the validation channel
          if (rc.eventValidationChannelId) {
            const vch = await interaction.client.channels.fetch(rc.eventValidationChannelId).catch(() => null);
            if (vch && vch.isTextBased()) {
              for (const r of rows) {
                if (r.staff_message_id) await vch.messages.delete(r.staff_message_id).catch(() => {});
                if (r.staff_control_message_id) await vch.messages.delete(r.staff_control_message_id).catch(() => {});
              }
            }
          }

          // Reset DB + scoreboard state
          ev.resetGuild(interaction.guildId);
          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});

          return interaction.reply({ content: '🧨 Reset saison effectué : scores + submissions + screens supprimés (box staff conservée).', ephemeral: true });
        }

        if (interaction.customId.startsWith('profset:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];
          const msgId = parts[3];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé Meneur / Bras droit.', ephemeral: true });

          const pseudos = (interaction.fields.getTextInputValue('pseudos') || '').trim();
          if (!pseudos) return interaction.reply({ content: 'Liste vide.', ephemeral: true });

          profiles.upsertProfile(guildId, targetUserId, pseudos);

          // refresh box
          await updateProfileBox(interaction.guild, rc, targetUserId, {
            statusText: '✍️ Mis à jour par le staff',
          }).catch(() => {});

          // keep edit button
          try {
            const ch = await interaction.client.channels.fetch(rc.profilesChannelId).catch(() => null);
            if (ch && ch.isTextBased()) {
              const m = await ch.messages.fetch(msgId).catch(() => null);
              if (m) {
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`profedit:${guildId}:${targetUserId}`).setLabel('✍️ Modifier').setStyle(ButtonStyle.Secondary)
                );
                await m.edit({ components: [row] }).catch(() => {});
              }
            }
          } catch {}

          return interaction.reply({ content: '✅ Profil mis à jour.', ephemeral: true });
        }

        if (interaction.customId.startsWith('ign:')) { 
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const userId = parts[2];
          const choice = parts[3];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.editReply({ content: 'Action invalide.' }).catch(() => {});
          }
          if (interaction.user.id !== userId) {
            return interaction.editReply({ content: 'Ce formulaire ne te concerne pas.' }).catch(() => {});
          }

          const rc = getConfigForGuild(guildId);
          const ignRaw = (interaction.fields.getTextInputValue('ign') || '').trim();
          if (!ignRaw || ignRaw.length < 2) {
            return interaction.editReply({ content: 'Pseudo en jeu invalide.' }).catch(() => {});
          }

          // Save profile (append, so user can submit again later if needed)
          const prof = profiles.appendToProfile(guildId, userId, ignRaw);
          const ignList = String(prof?.ign || '')
            .split(/\r?\n/)
            .map(s => s.trim())
            .filter(Boolean);

          // Post profile box
          if (rc.profilesChannelId) {
            const pch = await interaction.client.channels.fetch(rc.profilesChannelId).catch(() => null);
            if (pch && pch.isTextBased()) {
              const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('🎮 Profil joueur')
                .addFields(
                  { name: 'Discord', value: `<@${userId}> (\`${userId}\`)`, inline: false },
                  { name: 'Pseudos en jeu', value: ignList.map(x => `• **${x}**`).join('\n').slice(0, 1024), inline: false },
                  { name: 'Statut', value: choice === 'guildeux' ? '🛡️ Guildeux (en attente validation staff)' : '🎟️ Invité (en attente validation staff)', inline: false },
                )
                .setFooter({ text: 'Ajout automatique à l’arrivée.' });

              const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`profedit:${guildId}:${userId}`)
                  .setLabel('✍️ Modifier')
                  .setStyle(ButtonStyle.Secondary)
              );

              const sent = await pch.send({ embeds: [embed], components: [row] });
              try { profiles.setProfileMessageId(guildId, userId, sent.id); } catch {}
            }
          }

          // Assign role based on choice (same as clicking button)
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (member) {
            const roleG = rc.welcomeRoleGuildeuxId ? interaction.guild.roles.cache.get(rc.welcomeRoleGuildeuxId) : null;
            const roleI = rc.welcomeRoleInviteId ? interaction.guild.roles.cache.get(rc.welcomeRoleInviteId) : null;
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
              return interaction.reply({ content: "Je n'ai pas la permission **Gérer les rôles**.", ephemeral: true });
            }
            if (choice === 'guildeux') {
              // SECURITY: do NOT grant guild access before staff validation.
              // Put the member as "Invité" while waiting.
              if (roleI) await member.roles.add(roleI).catch(() => {});
              if (roleG) await member.roles.remove(roleG).catch(() => {});
              // Also ensure no guild roles are given here.
              const roleGTO = rc.gtoRoleId ? interaction.guild.roles.cache.get(rc.gtoRoleId) : null;
              const roleDEF = rc.defRoleId ? interaction.guild.roles.cache.get(rc.defRoleId) : null;
              if (roleGTO) await member.roles.remove(roleGTO).catch(() => {});
              if (roleDEF) await member.roles.remove(roleDEF).catch(() => {});

              await postStaffValidationAlert(interaction.guild, rc, userId, 'Guildeux');
            }
            if (choice === 'invite') {
              if (roleI) await member.roles.add(roleI).catch(() => {});
              if (roleG) await member.roles.remove(roleG).catch(() => {});
              await postStaffValidationAlert(interaction.guild, rc, userId, 'Invité');
            }
          }

          // After successful IGN submit: remove the role-choice buttons.
          // The GIF button will be enabled ONLY after staff validation.
          const msgId = parts[4];
          if (msgId) {
            try {
              const wch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
              if (wch && wch.isTextBased()) {
                const m = await wch.messages.fetch(msgId).catch(() => null);
                if (m) {
                  const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setCustomId(`welwait:${guildId}:${userId}`)
                      .setLabel('⏳ En attente de validation staff')
                      .setStyle(ButtonStyle.Secondary)
                      .setDisabled(true)
                  );
                  await m.edit({ components: [row] }).catch(() => {});
                }
              }
            } catch {}
          }

          return interaction.editReply({ content: '✅ Pseudo enregistré, merci !' }).catch(() => {});
        }
      }

      if (interaction.isChatInputCommand()) {
        const guild = interaction.guild;
        const rc = getConfigForGuild(guild.id);

        // Public commands (no admin required)
        if (interaction.commandName === 'almanax') {
          // Restrict usage to the configured channel (soft redirect; do not run elsewhere)
          if (rc.almanaxChannelId && interaction.channelId !== rc.almanaxChannelId) {
            return interaction.reply({ content: `📜 Utilise cette commande dans <#${rc.almanaxChannelId}>.`, ephemeral: true }).catch(() => {});
          }

          await interaction.deferReply({ ephemeral: false }).catch(() => {});

          const daysAhead = interaction.options.getInteger('jours');
          const prochains = interaction.options.getInteger('prochains');
          const prochainBonus = (interaction.options.getString('prochain_bonus') || '').trim();
          const bonusDisponibles = interaction.options.getBoolean('bonus_disponibles');
          const aide = interaction.options.getBoolean('aide');

          const chosen = [
            daysAhead !== null && daysAhead !== undefined,
            prochains !== null && prochains !== undefined,
            !!prochainBonus,
            !!bonusDisponibles,
            !!aide,
          ].filter(Boolean).length;
          if (chosen > 1) {
            return interaction.editReply({ content: '❌ Choisis **une seule** option (jours / prochains / prochain_bonus / bonus_disponibles / aide).' }).catch(() => {});
          }

          // Help
          if (aide) {
            const help = new EmbedBuilder()
              .setColor(0x9b59b6)
              .setTitle('📜 Almanax — Aide')
              .setDescription(
                [
                  '• **/almanax** â†’ Almanax du jour',
                  '• **/almanax jours:7** â†’ Almanax dans 7 jours (J+7)',
                  '• **/almanax prochains:10** â†’ liste des 10 prochains jours',
                  '• **/almanax bonus_disponibles:true** â†’ liste des bonus (slugs)',
                  '• **/almanax prochain_bonus:full-of-life** â†’ prochain jour avec ce bonus',
                ].join('\n')
              )
              .setFooter({ text: 'Source: krosmoz.com (scraping) — Touch' });
            return interaction.editReply({ embeds: [help] }).catch(() => {});
          }

          try {
            const tz = 'Europe/Paris';

            const norm = s => String(s || '')
              .toLowerCase()
              .normalize('NFD')
              .replace(/\p{Diacritic}/gu, '')
              .replace(/[^a-z0-9]+/g, ' ')
              .trim();

            if (bonusDisponibles) {
              // Kaelly ne fournit pas une liste de "slugs" : on fait une liste pratique des bonus (types)
              // en scannant les prochains jours.
              const maxDays = 30;
              const seen = new Map();

              for (let d = 0; d < maxDays; d++) {
                const ymd = parisYmdForDaysAhead(d);
                const a = await getKrosmozAlmanaxTouch({ ymd, lang: 'fr' });
                const key = norm(a.bonusType);
                if (key && !seen.has(key)) {
                  seen.set(key, a.bonusType);
                }
              }

              const lines = Array.from(seen.values())
                .sort((a, b) => a.localeCompare(b, 'fr'))
                .map(t => `• **${t}**`);

              const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle('🏷️ Bonus Almanax (Touch) — types détectés')
                .setDescription(
                  [
                    `Scan: prochains **${maxDays}** jours (TZ ${tz})`,
                    '',
                    ...(lines.length ? lines : ['—']),
                    '',
                    'Astuce: utilise **/almanax prochain_bonus:** avec un mot-clé (ex: `butin`, `xp`, `metier`).'
                  ].join('\n').slice(0, 3900)
                );

              return interaction.editReply({ embeds: [embed] }).catch(() => {});
            }

            if (prochainBonus) {
              // En mode "Kaelly": pas de slug API. On interprète l'entrée comme un MOT-CLÉ
              // et on scanne à l'avance jusqu'à trouver un bonus dont le type/description matche.
              const query = norm(prochainBonus);
              const limit = 366;

              let foundDaysAhead = null;
              let found = null;

              for (let d = 0; d < limit; d++) {
                const ymd = parisYmdForDaysAhead(d);
                const a = await getKrosmozAlmanaxTouch({ ymd, lang: 'fr' });
                const hay = norm(`${a.bonusType} ${a.bonusDesc}`);
                if (hay.includes(query)) {
                  foundDaysAhead = d;
                  found = a;
                  break;
                }
              }

              if (foundDaysAhead == null) {
                return interaction.editReply({ content: `❌ Aucun bonus correspondant trouvé dans les ${limit} prochains jours (recherche: \`${prochainBonus}\`).` }).catch(() => {});
              }

              const embed = await buildAlmanaxEmbed({ daysAhead: foundDaysAhead });
              embed.setTitle(`🔎 Prochain bonus (Touch) — ${prochainBonus}`);
              embed.setFooter({ text: `Trouvé à J+${foundDaysAhead} • Source: krosmoz.com • TZ ${tz}` });
              return interaction.editReply({ embeds: [embed] }).catch(() => {});
            }

            if (prochains) {
              const count = Math.max(1, Math.min(10, prochains));
              const lines = [];

              for (let d = 0; d < count; d++) {
                const ymd = parisYmdForDaysAhead(d);
                const a = await getKrosmozAlmanaxTouch({ ymd, lang: 'fr' });
                const bonusShort = `${a.bonusType} — ${String(a.bonusDesc).replace(/\s+/g, ' ').slice(0, 90)}`;
                const off = a.itemQty ? `${a.itemQty}× ${a.itemName}` : a.offeringText;
                lines.push(`**J+${d}** — **${ymd}**\n• Bonus: ${bonusShort}\n• Offrande: ${String(off).slice(0, 120)}`);
              }

              const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle(`📆 Prochains Almanax (Touch) (x${count})`)
                .setDescription(lines.join('\n\n').slice(0, 3900))
                .setFooter({ text: `TZ ${tz} • Source: krosmoz.com` });

              return interaction.editReply({ embeds: [embed] }).catch(() => {});
            }

            const d = daysAhead ?? 0;
            const embed = await buildAlmanaxEmbed({ daysAhead: d });
            return interaction.editReply({ embeds: [embed] }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `❌ Erreur Almanax: ${(e?.message || e)}`.slice(0, 1900) }).catch(() => {});
          }
        }

        // Admin auth: guild owner OR one of the allowed roles (meneur/dev mode)
        const isOwner = guild && interaction.user && guild.ownerId === interaction.user.id;
        const memberRoles = interaction.member?.roles;

        const hasLegacyAdmin = !!(memberRoles && rc.adminRoleIdsLegacy.some(rid => memberRoles.cache?.has(rid)));
        const hasConfiguredAdmin = !!(rc.adminRoleId && memberRoles && memberRoles.cache?.has(rc.adminRoleId));
        const isAdmin = isOwner || hasLegacyAdmin || hasConfiguredAdmin;

        // Owner-only setup commands
        if (interaction.commandName.startsWith('setup_')) {
          if (!isOwner) return interaction.reply({ content: 'Commande réservée au propriétaire du serveur.', ephemeral: true });
        } else if (!isAdmin) {
          return interaction.reply({ content: "Permissions insuffisantes (réservé à l'Owner ou rôle admin configuré).", ephemeral: true });
        }

        // Allow /role_id anywhere (useful on mobile)
        if (interaction.commandName === 'role_id') {
          const role = interaction.options.getRole('role', true);
          return interaction.reply({ content: `ID du rôle ${role} : \`${role.id}\``, ephemeral: true });
        }

        // Setup commands: allowed anywhere
        if (interaction.commandName.startsWith('setup_')) {
          if (interaction.commandName === 'setup_almanax') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte**.', ephemeral: true });
            }

            updateGuildConfig(guild.id, {
              almanax_channel_id: salon.id,
              // reset last post to allow immediate scheduling
              almanax_last_post_ymd: null,
            });

            // Post a pinned info message (best effort)
            try {
              const embed = new EmbedBuilder()
                .setColor(0x9b59b6)
                .setTitle('📜 Almanax — Dofus (mode d’emploi)')
                .setDescription(
                  [
                    'Commandes disponibles **dans ce salon uniquement** :',
                    '',
                    '• **/almanax** â†’ Almanax du jour',
                    '• **/almanax jours:7** â†’ Almanax dans 7 jours (J+7)',
                    '• **/almanax prochains:10** â†’ liste des 10 prochains jours',
                    '• **/almanax bonus_disponibles:true** â†’ liste des bonus (slugs)',
                    '• **/almanax prochain_bonus:full-of-life** â†’ prochain jour avec ce bonus',
                    '• **/almanax aide:true** â†’ rappel des commandes',
                    '',
                    'â° Publication automatique : **tous les jours à 00:00 (Europe/Paris)** (résumé).',
                  ].join('\n')
                )
                .setFooter({ text: 'Source: alm.dofusdu.de (almanax-api)' });

              const recent = await salon.messages.fetch({ limit: 15 }).catch(() => null);
              const existing = recent?.find(m => m.author?.id === guild.client.user.id && m.embeds?.[0]?.title === '📜 Almanax — Dofus');
              const msg = existing ? await existing.edit({ embeds: [embed] }).then(() => existing) : await salon.send({ embeds: [embed] });
              try { await msg.pin(); } catch {}
            } catch {}

            return interaction.reply({ content: `✅ Almanax configuré dans <#${salon.id}>.`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_admin') {
            const role = interaction.options.getRole('role', true);
            updateGuildConfig(guild.id, { admin_role_id: role.id });

            const rc2 = getConfigForGuild(guild.id);
            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Rôle admin configuré : ${role} (\`${role.id}\`).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_ping') {
            const panneau = interaction.options.getChannel('panneau', true);
            const alertes = interaction.options.getChannel('alertes', true);
            const defRole = interaction.options.getRole('def_role', true);
            const titre = interaction.options.getString('titre');
            const cooldown = interaction.options.getInteger('cooldown');

            updateGuildConfig(guild.id, {
              panel_channel_id: panneau.id,
              alert_channel_id: alertes.id,
              def_role_id: defRole.id,
              panel_title: titre || null,
              cooldown_seconds: cooldown || null,
            });

            const rc2 = getConfigForGuild(guild.id);
            // Create/update panel message
            const msg = await ensurePanelMessage(panneau, rc2);

            // Refresh dashboard if exists
            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Panneau configuré dans <#${panneau.id}> (alertes: <#${alertes.id}>) (message ${msg.id}).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_scoreboard') {
            const salon = interaction.options.getChannel('salon', true);
            const roleG = interaction.options.getRole('role_guildeux', true);
            const top = interaction.options.getInteger('top');

            updateGuildConfig(guild.id, {
              scoreboard_channel_id: salon.id,
              guildeux_role_id: roleG.id,
              scoreboard_top_n: top || null,
            });

            const rc2 = getConfigForGuild(guild.id);
            const sbChannel = await interaction.client.channels.fetch(rc2.scoreboardChannelId).catch(() => null);
            if (sbChannel && sbChannel.isTextBased()) {
              const msg = await scoreboard.ensureScoreboardMessage(guild, sbChannel, { topN: rc2.scoreboardTopN });

              // Refresh dashboard if exists
              if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
                const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
                if (dashChannel && dashChannel.isTextBased()) {
                  await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
                }
              }

              return interaction.reply({ content: `OK. Scoreboard configuré dans <#${sbChannel.id}> (message ${msg.id}).`, ephemeral: true });
            }
            return interaction.reply({ content: `Scoreboard configuré, mais salon inaccessible: <#${salon.id}>.`, ephemeral: true });
          }


          if (interaction.commandName === 'setup_status') {
            const rc2 = getConfigForGuild(guild.id);
            const lines = [
              `panel_channel_id: ${rc2.panelChannelId ? `<#${rc2.panelChannelId}>` : '❌'}`,
              `alert_channel_id: ${rc2.alertChannelId ? `<#${rc2.alertChannelId}>` : '❌'}`,
              `def_role_id: ${rc2.defRoleId ? `<@&${rc2.defRoleId}>` : '❌'}`,
              `panel_title: ${rc2.panelTitle || '—'}`,
              `cooldown_seconds: ${rc2.cooldownSeconds}`,
              `scoreboard_channel_id: ${rc2.scoreboardChannelId ? `<#${rc2.scoreboardChannelId}>` : '❌'}`,
              `guildeux_role_id: ${rc2.guildeuxRoleId ? `<@&${rc2.guildeuxRoleId}>` : '❌'}`,
              `scoreboard_top_n: ${rc2.scoreboardTopN}`,
              `admin_role_id: ${rc2.adminRoleId ? `<@&${rc2.adminRoleId}>` : '—'}`,
              `dashboard: ${rc2.dashboardChannelId ? `<#${rc2.dashboardChannelId}>` : '—'} / ${rc2.dashboardMessageId || '—'}`,
              `welcome: ${rc2.welcomeChannelId ? `<#${rc2.welcomeChannelId}>` : '—'} (guilde: ${rc2.welcomeGuildName || 'GTO'}) (everyone: ${rc2.welcomePingEveryone ? 'ON' : 'OFF'}) (roles: ${rc2.welcomeRoleGuildeuxId ? `<@&${rc2.welcomeRoleGuildeuxId}>` : '—'} / ${rc2.welcomeRoleInviteId ? `<@&${rc2.welcomeRoleInviteId}>` : '—'})`, 
            ];
            return interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', ephemeral: true });
          }

          if (interaction.commandName === 'setup_dashboard') {
            const salon = interaction.options.getChannel('salon', true);
            const rc2 = getConfigForGuild(guild.id);
            const msg = await ensureDashboardMessage(guild, salon, rc2);
            return interaction.reply({ content: `OK. Dashboard posté dans <#${salon.id}> (message ${msg.id}) et épinglé.`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_welcome') {
            const salon = interaction.options.getChannel('salon', true);
            const chatArrive = interaction.options.getChannel('chat_arrive', false);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** (pas une catégorie / vocal / thread).', ephemeral: true });
            }
            if (chatArrive && !chatArrive.isTextBased?.()) {
              return interaction.reply({ content: 'Le salon chat_arrive doit être un **salon texte**.', ephemeral: true });
            }

            const guildeName = interaction.options.getString('guilde') || 'GTO';
            const pingEveryone = interaction.options.getBoolean('ping_everyone');
            const roleGuildeux = interaction.options.getRole('role_guildeux');
            const roleInvite = interaction.options.getRole('role_invite');

            updateGuildConfig(guild.id, {
              welcome_channel_id: salon.id,
              welcome_chat_channel_id: chatArrive ? chatArrive.id : null,
              welcome_guild_name: guildeName,
              welcome_ping_everyone: pingEveryone ? 1 : 0,
              welcome_role_guildeux_id: roleGuildeux ? roleGuildeux.id : null,
              welcome_role_invite_id: roleInvite ? roleInvite.id : null,
            });

            const rc2 = getConfigForGuild(guild.id);
            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Salon arrivée configuré : <#${salon.id}> (guilde: ${guildeName}) (ping everyone: ${pingEveryone ? 'ON' : 'OFF'}) (roles: ${roleGuildeux ? roleGuildeux.toString() : '—'} / ${roleInvite ? roleInvite.toString() : '—'}).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_reglement') {
            const salon = interaction.options.getChannel('salon', true);
            const roleAcces = interaction.options.getRole('role_acces', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour le règlement.', ephemeral: true });
            }

            updateGuildConfig(guild.id, {
              rules_channel_id: salon.id,
              rules_access_role_id: roleAcces.id,
            });

            const rc2 = getConfigForGuild(guild.id);
            await ensureRulesMessage(salon, rc2);

            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Règlement configuré dans <#${salon.id}>. Rôle après validation : ${roleAcces}`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_validation_staff') {
            const salon = interaction.options.getChannel('salon', true);
            const staff1 = interaction.options.getRole('staff1', true);
            const staff2 = interaction.options.getRole('staff2', false);
            const roleGto = interaction.options.getRole('role_gto', true);
            const roleDef = interaction.options.getRole('role_def', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour la validation.', ephemeral: true });
            }

            const staffIds = [staff1.id, staff2?.id].filter(Boolean).join(',');
            updateGuildConfig(guild.id, {
              validation_channel_id: salon.id,
              validation_staff_role_ids: staffIds,
              validation_gto_role_id: roleGto.id,
              validation_def_role_id: roleDef.id,
            });

            const rc2 = getConfigForGuild(guild.id);
            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Validation staff configurée dans <#${salon.id}>.`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_profiles') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour les profils.', ephemeral: true });
            }
            updateGuildConfig(guild.id, { profiles_channel_id: salon.id });

            const rc2 = getConfigForGuild(guild.id);
            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Salon profils configuré : <#${salon.id}>`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_profil_ankama') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour le panneau Ankama.', ephemeral: true });
            }

            updateGuildConfig(guild.id, { ankama_profile_channel_id: salon.id });
            const rc2 = getConfigForGuild(guild.id);

            await ensureAnkamaProfilePanel(guild, salon, rc2);

            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Panneau profil Ankama configuré dans <#${salon.id}> (épinglé).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_dofusbook_panel') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour le panneau Dofusbook.', ephemeral: true });
            }

            updateGuildConfig(guild.id, { dofusbook_panel_channel_id: salon.id });
            const rc2 = getConfigForGuild(guild.id);

            await ensureDofusbookPanel(guild, salon, rc2);

            if (rc2.dashboardChannelId && rc2.dashboardMessageId) {
              const dashChannel = await interaction.client.channels.fetch(rc2.dashboardChannelId).catch(() => null);
              if (dashChannel && dashChannel.isTextBased()) {
                await ensureDashboardMessage(guild, dashChannel, rc2, { allowCreate: false });
              }
            }

            return interaction.reply({ content: `OK. Panneau Dofusbook configuré dans <#${salon.id}> (épinglé).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_help') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour le guide.', ephemeral: true });
            }
            updateGuildConfig(guild.id, { help_channel_id: salon.id });
            const rc2 = getConfigForGuild(guild.id);
            await ensureHelpMessage(guild, rc2);
            return interaction.reply({ content: `OK. Guide staff posté dans <#${salon.id}> (épinglé).`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_surveillance') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour la surveillance.', ephemeral: true });
            }
            updateGuildConfig(guild.id, { surveillance_channel_id: salon.id });
            return interaction.reply({ content: `OK. Surveillance configurée dans <#${salon.id}>.`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_activity_logs') {
            const salon = interaction.options.getChannel('salon', true);
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** pour les activity logs.', ephemeral: true });
            }
            updateGuildConfig(guild.id, { activitylog_channel_id: salon.id });
            const rc2 = getConfigForGuild(guild.id);
            await ensureActivityLogHeader(guild, rc2);
            return interaction.reply({ content: `OK. Activity logs configurés dans <#${salon.id}>.`, ephemeral: true });
          }

          if (interaction.commandName === 'setup_events') {
            // Avoid Discord's 3s timeout: ack first
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            const preuves = interaction.options.getChannel('preuves', true);
            const validation = interaction.options.getChannel('validation', true);
            const classement = interaction.options.getChannel('classement', true);
            const screens = interaction.options.getChannel('screens', false);
            const panneau = interaction.options.getChannel('panneau', false);

            // Extra validation: ensure channels are from this guild and fetchable
            const preuvesCh = await interaction.guild.channels.fetch(preuves.id).catch(() => null);
            const validationCh = await interaction.guild.channels.fetch(validation.id).catch(() => null);
            const classementCh = await interaction.guild.channels.fetch(classement.id).catch(() => null);
            const screensCh = screens ? await interaction.guild.channels.fetch(screens.id).catch(() => null) : null;
            const panelCh = panneau ? await interaction.guild.channels.fetch(panneau.id).catch(() => null) : null;

            if (!preuvesCh || !validationCh || !classementCh) {
              return interaction.editReply({ content: '❌ Un des salons sélectionnés est introuvable (ID invalide / pas dans ce serveur).' }).catch(() => {});
            }

            if (!preuvesCh.isTextBased?.() || !validationCh.isTextBased?.() || !classementCh.isTextBased?.() || (screensCh && !screensCh.isTextBased?.()) || (panelCh && !panelCh.isTextBased?.())) {
              return interaction.editReply({ content: '❌ Choisis uniquement des **salons texte** (pas catégorie/voice/forum).' }).catch(() => {});
            }

            updateGuildConfig(guild.id, {
              event_proofs_channel_id: preuvesCh.id,
              event_validation_channel_id: validationCh.id,
              event_scoreboard_channel_id: classementCh.id,
              event_screens_channel_id: screensCh ? screensCh.id : null,
              // by default, staff admin panel lives in validation
              event_admin_channel_id: validationCh.id,
              // submit panel can be in a different channel than proofs
              event_submit_panel_channel_id: (panelCh || preuvesCh).id,
            });

            // IMPORTANT: re-running /setup_events should reset the event system (scores + old submissions)
            // so you get a fresh season.
            try { ev.resetGuild(guild.id); } catch {}

            const rc2 = getConfigForGuild(guild.id);

            // Create/update scoreboard + staff admin panel (best-effort)
            const warnings = [];
            try { await ensureEventScoreboard(guild, rc2); } catch (e) { warnings.push(`Scoreboard: ${e?.message || e}`); }
            try { await ensureEventAdminPanel(guild, rc2); } catch (e) { warnings.push(`Panel staff: ${e?.message || e}`); }

            // Post pinned submission panel (can be in a different channel than proofs)
            try {
              const targetPanelCh = panelCh || preuvesCh;

              const panelEmbed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('📸 Événements Perco — Soumission')
                .setDescription(
                  [
                    '**Comment soumettre un combat :**',
                    '1) Clique sur **📤 Soumettre un combat**',
                    '2) Dans le thread créé, **mentionne tous les participants**',
                    '   âžœ **N’oublie pas de t’identifier toi-même si tu as participé au combat**',
                    '3) Envoie ensuite **1 ou 2 screenshots** (date/heure visibles)',
                    '',
                    '📌 Le staff valide ensuite. En cas de refus, tu seras ping avec la raison.',
                  ].join('\n')
                )
                .addFields(
                  {
                    name: '✅ Règles (obligatoires)',
                    value: [
                      '• Date + heure visibles',
                      '• Tous les attaquants + défenseurs (**perco inclus**) visibles',
                      '• Max **2** images',
                    ].join('\n'),
                    inline: false,
                  },
                  {
                    name: '💡 Astuce',
                    value: 'Si vous avez oublié quelqu’un dans les mentions, prévenez le staff avant validation.',
                    inline: false,
                  },
                )
                .setImage('attachment://event-perco-banner.png');

              const panelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`evopen:${guild.id}`).setLabel('📤 Soumettre un combat').setStyle(ButtonStyle.Primary),
              );

              // pin one panel (best effort)
              const recent = await targetPanelCh.messages.fetch({ limit: 20 }).catch(() => null);
              const existing = recent?.find(m => m.author?.id === guild.client.user.id && m.embeds?.[0]?.title === '📸 Événements Perco — Soumission');
              const bannerPath = path.join(__dirname, '..', 'assets', 'event-perco-banner.png');
              const files = [];
              try { files.push({ attachment: bannerPath, name: 'event-perco-banner.png' }); } catch {}

              const panelMsg = existing
                ? await existing.edit({ embeds: [panelEmbed], components: [panelRow], files }).then(() => existing)
                : await targetPanelCh.send({ embeds: [panelEmbed], components: [panelRow], files });
              try { await panelMsg.pin(); } catch {}
              try { updateGuildConfig(guild.id, { event_submit_panel_channel_id: targetPanelCh.id, event_submit_panel_message_id: panelMsg.id }); } catch {}
            } catch (e) {
              warnings.push(`Soumission panel: ${e?.message || e}`);
            }

            const warnText = warnings.length ? `\n\n⚠️ Warnings:\n• ${warnings.join('\n• ').slice(0, 1500)}` : '';
            return interaction.editReply({
              content:
                `✅ OK. Events configurés.\n` +
                `Preuves (threads + posts): <#${preuvesCh.id}>\n` +
                `Box soumission: <#${(panelCh || preuvesCh).id}>\n` +
                `Validation: <#${validationCh.id}>\n` +
                `Classement: <#${classementCh.id}>\n` +
                `Screens: ${screensCh ? `<#${screensCh.id}>` : '— (non configuré)'}` +
                warnText,
            }).catch(() => {});
          }

          if (interaction.commandName === 'clean') {
            const n = Math.min(100, Math.max(1, interaction.options.getInteger('nombre') || 50));

            // Avoid interaction timeout
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            if (!interaction.channel || !interaction.channel.isTextBased()) {
              return interaction.editReply({ content: 'Salon invalide.' }).catch(() => {});
            }
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
              return interaction.editReply({ content: "Je n'ai pas la permission **Gérer les messages**." }).catch(() => {});
            }

            await interaction.editReply({ content: `🧹 Nettoyage en cours (${n} messages)…` }).catch(() => {});
            try {
              const deleted = await interaction.channel.bulkDelete(n, true);
              return interaction.editReply({ content: `✅ ${deleted.size} messages supprimés.` }).catch(() => {});
            } catch (e) {
              return interaction.editReply({ content: `Erreur: ${e.message}` }).catch(() => {});
            }
          }

          if (interaction.commandName === 'lock_write') {
            // Avoid interaction timeout ASAP
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            const salon = interaction.options.getChannel('salon', true);
            const role1 = interaction.options.getRole('role_autorise1', true);
            const role2 = interaction.options.getRole('role_autorise2', false);
            const role3 = interaction.options.getRole('role_autorise3', false);
            const unlock = interaction.options.getBoolean('unlock') || false;
            const roles = [role1, role2, role3].filter(Boolean);

            if (!salon.isTextBased?.()) {
              return interaction.editReply({ content: 'Choisis un salon texte.' }).catch(() => {});
            }

            // owner only
            if (interaction.guild.ownerId !== interaction.user.id) {
              return interaction.editReply({ content: 'Commande réservée au propriétaire du serveur.' }).catch(() => {});
            }

            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
              return interaction.editReply({ content: "Je n'ai pas la permission **Gérer les salons**." }).catch(() => {});
            }

            const everyoneId = interaction.guild.roles.everyone.id;

            try {
              if (unlock) {
                // Remove overwrite for @everyone to restore inherited perms
                await salon.permissionOverwrites.delete(everyoneId).catch(() => {});
                await interaction.editReply({ content: `🔓 Déverrouillé : <#${salon.id}>` });
              } else {
                await salon.permissionOverwrites.edit(everyoneId, { SendMessages: false });
                for (const r of roles) {
                  await salon.permissionOverwrites.edit(r.id, { SendMessages: true });
                }
                await interaction.editReply({ content: `🔒 Verrouillé : <#${salon.id}> (écriture autorisée: ${roles.map(r => r.toString()).join(' ')})` });
              }
            } catch (e) {
              return interaction.editReply({ content: `Erreur: ${e.message}` }).catch(() => {});
            }

            return;
          }

          return interaction.reply({ content: 'Commande setup inconnue.', ephemeral: true });
        } else {
          // Allow some admin utilities anywhere
          const anywhere = new Set(['clean', 'lock_write', 'role_id']);
          if (!anywhere.has(interaction.commandName)) {
            // Command restriction: only allow admin commands in the panel channel
            if (rc.panelChannelId && interaction.channelId !== rc.panelChannelId) {
              return interaction.reply({ content: `Commande autorisée uniquement dans <#${rc.panelChannelId}>.`, ephemeral: true });
            }
          }
        }

        // Admin utilities (available from any channel)
        if (interaction.commandName === 'profile_reset') {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = interaction.guild.ownerId === interaction.user.id || !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.editReply({ content: 'Réservé Meneur / Bras droit / Owner.' }).catch(() => {});

          const user = interaction.options.getUser('membre', true);
          const existing = profiles.deleteProfile(interaction.guild.id, user.id);
          if (rc.profilesChannelId && existing?.profile_message_id) {
            const ch = await interaction.client.channels.fetch(rc.profilesChannelId).catch(() => null);
            if (ch && ch.isTextBased()) {
              await ch.messages.delete(existing.profile_message_id).catch(() => {});
            }
          }
          return interaction.editReply({ content: `✅ Profil supprimé pour ${user}.` }).catch(() => {});
        }

        if (interaction.commandName === 'profile_set') {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = interaction.guild.ownerId === interaction.user.id || !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.editReply({ content: 'Réservé Meneur / Bras droit / Owner.' }).catch(() => {});

          const user = interaction.options.getUser('membre', true);
          const pseudos = interaction.options.getString('pseudos', true);
          profiles.upsertProfile(interaction.guild.id, user.id, pseudos);
          await updateProfileBox(interaction.guild, rc, user.id, { statusText: '✍️ Mis à jour par le staff' }).catch(() => {});
          return interaction.editReply({ content: `✅ Profil mis à jour pour ${user}.` }).catch(() => {});
        }

        if (interaction.commandName === 'clean') {
          const n = Math.min(100, Math.max(1, interaction.options.getInteger('nombre') || 50));
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          if (!interaction.channel || !interaction.channel.isTextBased()) {
            return interaction.editReply({ content: 'Salon invalide.' }).catch(() => {});
          }
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return interaction.editReply({ content: "Je n'ai pas la permission **Gérer les messages**." }).catch(() => {});
          }

          await interaction.editReply({ content: `🧹 Nettoyage en cours (${n} messages)…` }).catch(() => {});
          try {
            const deleted = await interaction.channel.bulkDelete(n, true);
            return interaction.editReply({ content: `✅ ${deleted.size} messages supprimés.` }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `Erreur: ${e.message}` }).catch(() => {});
          }
        }

        if (interaction.commandName === 'lock_write') {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const salon = interaction.options.getChannel('salon', true);
          const role1 = interaction.options.getRole('role_autorise1', true);
          const role2 = interaction.options.getRole('role_autorise2', false);
          const role3 = interaction.options.getRole('role_autorise3', false);
          const unlock = interaction.options.getBoolean('unlock') || false;
          const roles = [role1, role2, role3].filter(Boolean);

          if (!salon.isTextBased?.()) {
            return interaction.editReply({ content: 'Choisis un salon texte.' }).catch(() => {});
          }
          if (interaction.guild.ownerId !== interaction.user.id) {
            return interaction.editReply({ content: 'Commande réservée au propriétaire du serveur.' }).catch(() => {});
          }
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
            return interaction.editReply({ content: "Je n'ai pas la permission **Gérer les salons**." }).catch(() => {});
          }

          const everyoneId = interaction.guild.roles.everyone.id;
          try {
            if (unlock) {
              await salon.permissionOverwrites.delete(everyoneId).catch(() => {});
              return interaction.editReply({ content: `🔓 Déverrouillé : <#${salon.id}>` }).catch(() => {});
            }

            await salon.permissionOverwrites.edit(everyoneId, { SendMessages: false });
            for (const r of roles) {
              await salon.permissionOverwrites.edit(r.id, { SendMessages: true });
            }
            return interaction.editReply({ content: `🔒 Verrouillé : <#${salon.id}> (écriture autorisée: ${roles.map(r => r.toString()).join(' ')})` }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `Erreur: ${e.message}` }).catch(() => {});
          }
        }

        if (interaction.commandName === 'panneau_creer') { 
          const channel = interaction.options.getChannel('canal', true);
          const alertChannel = interaction.options.getChannel('canal_alerte', true);
          const rc = getConfigForGuild(interaction.guild.id);
          const title = interaction.options.getString('titre') || rc.panelTitle;
          const pin = interaction.options.getBoolean('epingle') || false;

          panel.upsertPanel(interaction.guild.id, channel.id, { title, alertChannelId: alertChannel.id });
          const msg = await ensurePanelMessage(channel, rc);
          if (pin) {
            try { await msg.pin(); } catch {}
          }
          return interaction.reply({ content: `Panneau prêt dans <#${channel.id}> (alertes dans <#${alertChannel.id}>) (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'panneau_actualiser') {
          const channel = interaction.options.getChannel('canal', true);
          const rc = getConfigForGuild(interaction.guild.id);
          const msg = await ensurePanelMessage(channel, rc);
          return interaction.reply({ content: `Panneau actualisé dans <#${channel.id}> (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'generateurstuff') {
          // Admin-only + restricted channel
          if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Commande réservée aux **admins** du serveur.', ephemeral: true });
          }

          const target = interaction.options.getChannel('salon', false) || interaction.channel;
          if (!target?.isTextBased?.()) {
            return interaction.reply({ content: 'Choisis un **salon texte**.', ephemeral: true });
          }

          if (target.id !== STUFF_GEN_CHANNEL_ID) {
            return interaction.reply({ content: `Cette commande doit être utilisée dans <#${STUFF_GEN_CHANNEL_ID}>.`, ephemeral: true });
          }

          // Verify catalog readable
          try {
            const { items, catalogPath } = stuffGen.loadCatalog();
            if (!items.length) {
              return interaction.reply({ content: `Catalogue vide: ${catalogPath}`, ephemeral: true });
            }
          } catch (e) {
            return interaction.reply({ content: `Catalogue introuvable/corrompu. (${e?.message || e})`, ephemeral: true });
          }

          const sessionId = stuffGen.newSessionId();
          stuffSessions.set(sessionId, { criteria: { element: null, pa: null, pm: null } });

          const components = stuffGen.buildUI(sessionId, { element: null, pa: null, pm: null }, { regenLabel: 'Générer' });

          await interaction.reply({ content: '✅ Dashboard posté.', ephemeral: true });

          const msg = await target.send({
            content: [
              '**Générateur de stuff — Dashboard**',
              'Choisis **Élément**, **PA**, **PM**, puis clique **Générer**.',
              '(Les résultats arrivent en privé / éphémère.)',
            ].join('\n'),
            components,
            allowedMentions: { parse: [] },
          });
          try { await msg.pin(); } catch {}

          return;
        }

        if (interaction.commandName === 'metiers-install') {
          if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Commande réservée aux **admins** du serveur.', ephemeral: true });
          }

          if (interaction.channelId !== metiers.CHANNEL_DASHBOARD_INSTALL) {
            return interaction.reply({ content: `Installe le dashboard uniquement dans <#${metiers.CHANNEL_DASHBOARD_INSTALL}>.`, ephemeral: true });
          }

          const embed = metiers.buildDashboardEmbed();
          const components = metiers.buildDashboardButtons();

          await interaction.reply({ content: '✅ Dashboard métiers posté.', ephemeral: true });
          const msg = await interaction.channel.send({
            embeds: [embed],
            files: [{ attachment: metiers.DASHBOARD_IMAGE_PATH, name: 'metiers_dashboard.png' }],
            components,
            allowedMentions: { parse: [] },
          });
          try { await msg.pin(); } catch {}
          return;
        }

        if (interaction.commandName === 'metiers-emojisync') {
          if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Commande réservée aux **admins** du serveur.', ephemeral: true });
          }

          await interaction.reply({ content: '🔄 Sync des emojis métiers…', ephemeral: true });

          const catalog = metiers.getJobsCatalog();
          const db = metiers.readJsonSafe(metiers.JOBS_EMOJIS_PATH, { version: 1, emojis: {} });
          if (!db.emojis) db.emojis = {};

          // Build existing emoji map by name
          const existing = new Map();
          for (const e of interaction.guild.emojis.cache.values()) {
            existing.set(e.name, e);
          }

          let created = 0;
          let reused = 0;
          let missingFile = 0;
          let failed = 0;

          for (const j of catalog) {
            const emojiName = `m_${j.key}`.slice(0, 32);

            // If emoji already exists on this guild, reuse it (and refresh mapping)
            const ex = existing.get(emojiName);
            if (ex) {
              db.emojis[j.key] = `<:${ex.name}:${ex.id}>`;
              reused += 1;
              continue;
            }

            const file = path.join(metiers.JOB_ICONS_DIR, `${j.key}.png`);
            if (!fs.existsSync(file)) {
              missingFile += 1;
              continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const emoji = await interaction.guild.emojis.create({ attachment: file, name: emojiName }).catch(() => null);
            if (!emoji) {
              failed += 1;
              continue;
            }

            db.emojis[j.key] = `<:${emoji.name}:${emoji.id}>`;
            existing.set(emoji.name, emoji);
            created += 1;

            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 900));
          }

          metiers.writeJsonAtomic(metiers.JOBS_EMOJIS_PATH, db);
          await interaction.editReply({
            content: `✅ Emojis sync terminé. Créés: **${created}** • Réutilisés: **${reused}** • Fichiers manquants: **${missingFile}** • Échecs: **${failed}**`,
          }).catch(() => {});
          return;
        }

        if (interaction.commandName === 'metiers-testpingchannel') {
          if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Admins uniquement.', ephemeral: true });
          }

          const pingId = metiers.CHANNEL_PING_REQUESTS;
          const ch = await interaction.client.channels.fetch(pingId).catch((e) => {
            console.error('[debug] fetch channel failed', e);
            return null;
          });

          if (!ch) {
            return interaction.reply({ content: `❌ Impossible de fetch le salon ${pingId}`, ephemeral: true });
          }

          const info = [
            `id=${ch.id}`,
            `name=${ch.name || '(no name)'}`,
            `type=${ch.type}`,
            `isTextBased=${typeof ch.isTextBased === 'function' ? ch.isTextBased() : 'n/a'}`,
            `isThread=${Boolean(ch.isThread)}`,
            `parentId=${ch.parentId || '—'}`,
            // thread props
            `archived=${ch.archived ?? '—'}`,
            `locked=${ch.locked ?? '—'}`,
          ].join('\n');

          const sent = await ch.send({ content: `✅ DEBUG: message test depuis ${interaction.user.tag}` }).catch((e) => {
            console.error('[debug] send failed', e);
            return null;
          });

          if (!sent) {
            return interaction.reply({
              content: `❌ Send FAILED.\n\nInfos salon:\n\
\
${info}`.slice(0, 1900),
              ephemeral: true,
            });
          }

          return interaction.reply({
            content: `✅ Send OK (msgId=${sent.id}).\n\nInfos salon:\n\
\
${info}`.slice(0, 1900),
            ephemeral: true,
          });
        }

        if (interaction.commandName === 'scoreboard_weekly_run') {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const rc2 = getConfigForGuild(guild.id);
          const reset = interaction.options.getBoolean('reset');

          if (!rc2.scoreboardChannelId) {
            return interaction.editReply({ content: 'Scoreboard non configuré (setup_scoreboard).' }).catch(() => {});
          }

          const sbChannel = await interaction.client.channels.fetch(rc2.scoreboardChannelId).catch(() => null);
          if (!sbChannel || !sbChannel.isTextBased()) {
            return interaction.editReply({ content: 'Salon scoreboard inaccessible.' }).catch(() => {});
          }

          const embed = await scoreboard.buildScoreboardEmbed(guild, { topN: Math.min(10, rc2.scoreboardTopN || 10), skipMemberFetch: true });
          embed.setTitle('🏆 Classement hebdo — Guildeux (pings)');

          // Make it more celebratory
          const lines = String(embed.data?.description || '').split('\n');
          const top1 = lines.find(l => l.includes('**01.**')) || lines[0] || '';
          const top3 = lines.slice(0, 3).join('\n');

          embed.setDescription(
            [
              '📣 **Merci à tous pour votre réactivité !**',
              '',
              `🥇 **Vainqueur :** ${top1.replace('**01.** ', '') || '—'}`,
              '',
              '🏅 **Top 3 :**',
              top3 || '—',
              '',
              '🎁 **Récompense :** contactez le **meneur** pour récupérer **30% de la banque du meneur** 👀',
            ].join('\n').slice(0, 3900)
          );

          // Add banner image
          const files = [];
          try {
            const bannerPath = path.join(__dirname, '..', 'assets', 'event-official-banner.jpg');
            if (require('fs').existsSync(bannerPath)) {
              files.push({ attachment: bannerPath, name: 'event-official-banner.jpg' });
              embed.setImage('attachment://event-official-banner.jpg');
            }
          } catch {}

          embed.setFooter({ text: 'Annonce manuelle + reset.' });

          await sbChannel.send({ embeds: [embed], files });

          const doReset = reset !== false;
          if (doReset) {
            await scoreboard.rotateWeeklyBoard(guild, sbChannel, { boardTopN: rc2.scoreboardTopN });
          }

          return interaction.editReply({ content: `✅ Annonce envoyée${doReset ? ' + reset + nouveau tableau posté' : ''}.` }).catch(() => {});
        }

        if (interaction.commandName === 'guilde_ajouter') {
          const rc = getConfigForGuild(interaction.guild.id);
          // Robust fallback: if panel not configured yet, use the channel where the command is executed.
          // This prevents SQLITE NOT NULL errors on channel_id.
          const channelId = rc.panelChannelId || config.defaultChannelId || interaction.channelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          const role = interaction.options.getRole('role', true);
          const label = (interaction.options.getString('label') || name).slice(0, 80);
          let emoji = interaction.options.getString('emoji');
          const image = interaction.options.getAttachment('image');

          // Allow explicit “no emojiâ€ sentinel values (useful if a Discord client caches the option as required)
          if (emoji) {
            const e = String(emoji).trim().toLowerCase();
            if (e === '-' || e === 'none' || e === 'no' || e === 'aucun' || e === 'aucune') {
              emoji = null;
            }
          }
          const order = interaction.options.getInteger('ordre') || 0;
          const unicodePrefix = interaction.options.getString('prefixe') || null;

          // Normalize emoji if user typed :name:
          if (emoji && /^:[\w-]{2,32}:$/.test(emoji)) {
            const nameOnly = emoji.slice(1, -1);
            const found = interaction.guild.emojis.cache.find(e => e.name === nameOnly);
            if (found) emoji = found.toString();
          }

          // If an image is provided, convert it to a custom emoji and use it.
          if (image) {
            // Permissions: ManageEmojisAndStickers
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageEmojisAndStickers)) {
              return interaction.reply({ content: "Je n'ai pas la permission **Gérer les emojis et autocollants**.", ephemeral: true });
            }

            try {
              // Download
              const resp = await fetch(image.url);
              if (!resp.ok) throw new Error(`download failed (${resp.status})`);
              const buf = Buffer.from(await resp.arrayBuffer());

              // Convert to 128x128 png, center-crop
              const png = await sharp(buf)
                .resize(128, 128, { fit: 'cover', position: 'centre' })
                .png()
                .toBuffer();

              // Emoji name constraints: 2-32, alnum/_
              const emojiName = (`g_${name}`.toLowerCase()).replace(/[^a-z0-9_]/g, '_').slice(0, 32);

              const created = await interaction.guild.emojis.create({ attachment: png, name: emojiName });
              emoji = created.toString(); // store raw mention (<:name:id>)
            } catch (e) {
              return interaction.reply({ content: `Erreur lors de la conversion/upload emoji: ${e.message}`, ephemeral: true });
            }
          }

          panel.upsertGuildButton(interaction.guild.id, channelId, {
            name,
            roleId: role.id,
            label,
            emoji,
            unicodePrefix,
            sortOrder: order,
          });

          const panelChannel = await interaction.client.channels.fetch(channelId);
          await ensurePanelMessage(panelChannel, rc);
          return interaction.reply({ content: `Guilde ${name} ajoutée/modifiée → <@&${role.id}>.`, ephemeral: true });
        }

        if (interaction.commandName === 'guilde_supprimer') {
          const rc = getConfigForGuild(interaction.guild.id);
          const channelId = rc.panelChannelId || config.defaultChannelId || interaction.channelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          panel.removeGuildButton(interaction.guild.id, channelId, name);
          const panelChannel = await interaction.client.channels.fetch(channelId);
          await ensurePanelMessage(panelChannel, rc);
          return interaction.reply({ content: `Guilde ${name} supprimée du panneau.`, ephemeral: true });
        }

      }

      if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
        // Métiers selects
        if (interaction.customId === 'mj:search_cat') {
          const cat = interaction.values?.[0];
          const list = metiers.getJobsCatalog();
          const options = list
            .filter((j) => (cat === 'forgemagie' ? j.category === 'forgemagie' : j.category !== 'forgemagie'))
            .slice(0, 25)
            .map((j) => ({ label: j.label, value: j.key }));

          const sel = new StringSelectMenuBuilder()
            .setCustomId(`mj:search_job:${cat}`)
            .setPlaceholder(cat === 'forgemagie' ? 'Choisis un métier de forgemagie' : 'Choisis un métier')
            .addOptions(options);

          const back = new ButtonBuilder().setCustomId('mj:search').setLabel('⬅️ Retour').setStyle(ButtonStyle.Secondary);

          return interaction.update({
            content: '🔎 Recherche : choisis un métier',
            components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(back)],
          }).catch(() => {});
        }

        if (interaction.customId === 'mj:add_cat') {
          const cat = interaction.values?.[0];
          const list = metiers.getJobsCatalog();
          const options = list
            // only top-level for add flow (children picked after selecting group)
            .filter((j) => !j.parent)
            .filter((j) => (cat === 'forgemagie' ? j.category === 'forgemagie' : j.category !== 'forgemagie'))
            .slice(0, 25)
            .map((j) => ({ label: j.label, value: j.key }));

          const sel = new StringSelectMenuBuilder()
            .setCustomId(`mj:choose:${cat}`)
            .setPlaceholder(cat === 'forgemagie' ? 'Choisis un métier de forgemagie' : 'Choisis un métier')
            .addOptions(options);

          const back = new ButtonBuilder().setCustomId('mj:add').setLabel('⬅️ Retour').setStyle(ButtonStyle.Secondary);

          return interaction.update({
            content: '➕ Ajouter / modifier : choisis un métier',
            components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(back)],
          }).catch(() => {});
        }

        if (interaction.customId.startsWith('mj:choose:')) {
          const key = interaction.values?.[0];
          const jobs = metiers.getJobsCatalog();
          const hit = jobs.find((j) => j.key === key);
          const label = hit?.label || key;

          // If group selected (Forgeron / Sculpteur / Sculptemage), ask specialization
          if (hit?.group) {
            const children = jobs.filter((j) => j.parent === hit.key);
            const opts = children.slice(0, 25).map((j) => ({ label: j.label, value: j.key }));
            const sel = new StringSelectMenuBuilder()
              .setCustomId(`mj:spec:${hit.key}`)
              .setPlaceholder(`Spécialité — ${label}`)
              .addOptions(opts);

            const back = new ButtonBuilder().setCustomId('mj:add').setLabel('⬅️ Retour').setStyle(ButtonStyle.Secondary);

            await interaction.update({
              content: `Choisis la spécialité pour **${label}** :`,
              components: [new ActionRowBuilder().addComponents(sel), new ActionRowBuilder().addComponents(back)],
            }).catch(() => {});
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId(`mj:add_level:${key}:${label}`)
            .setTitle(`Niveau — ${label}`);

          const input = new TextInputBuilder()
            .setCustomId('level')
            .setLabel('Niveau (1 à 100)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(3)
            .setPlaceholder('ex: 80');

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return;
        }

        if (interaction.customId.startsWith('mj:spec:')) {
          const specKey = interaction.values?.[0];
          const jobs = metiers.getJobsCatalog();
          const hit = jobs.find((j) => j.key === specKey);
          const label = hit?.label || specKey;

          const modal = new ModalBuilder()
            .setCustomId(`mj:add_level:${specKey}:${label}`)
            .setTitle(`Niveau — ${label}`);

          const input = new TextInputBuilder()
            .setCustomId('level')
            .setLabel('Niveau (1 à 100)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(3)
            .setPlaceholder('ex: 80');

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal).catch(() => {});
          return;
        }

        if (interaction.customId === 'mj:del_choose') {
          const key = interaction.values?.[0];
          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          if (!db.users) db.users = {};
          const prev = db.users[interaction.user.id] || {};
          const jobs = Array.isArray(prev.jobs) ? prev.jobs : [];
          const nextJobs = jobs.filter((j) => j.key !== key);
          db.users[interaction.user.id] = { jobs: nextJobs, messageId: prev.messageId || null, updatedAt: new Date().toISOString() };
          metiers.writeJsonAtomic(metiers.JOBS_USERS_PATH, db);

          // Update public fiche
          try {
            const ch = await interaction.client.channels.fetch(metiers.CHANNEL_FICHES_PUBLIC).catch(() => null);
            if (ch && ch.isTextBased()) {
              if (prev.messageId) {
                const m = await ch.messages.fetch(prev.messageId).catch(() => null);
                if (m) {
                  const embed = await metiers.buildUserJobsEmbed(interaction.user, nextJobs, { updatedAt: db.users?.[interaction.user.id]?.updatedAt });
                  await m.edit({ embeds: [embed] }).catch(() => {});
                }
              }
            }
          } catch {}

          return interaction.reply({ content: '✅ Métier supprimé et fiche mise à jour.', ephemeral: true }).catch(() => {});
        }

        if (interaction.customId.startsWith('mj:search_job:')) {
          const key = interaction.values?.[0];
          const list = metiers.getJobsCatalog();
          const hit = list.find((j) => j.key === key);
          const label = hit?.label || key;

          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          const users = db.users || {};

          const matches = [];
          for (const [userId, profile] of Object.entries(users)) {
            const jobs = Array.isArray(profile.jobs) ? profile.jobs : [];
            const j = jobs.find((x) => x.key === key || metiers.normalizeJobName(x.label) === metiers.normalizeJobName(label));
            if (j) matches.push({ userId, level: j.level || 0 });
          }
          matches.sort((a, b) => (b.level || 0) - (a.level || 0));

          await interaction.update({ content: `Résultats pour **${label}** (${matches.length}) :`, components: [] }).catch(() => {});
          if (!matches.length) {
            await interaction.followUp({ content: 'Aucun résultat.', ephemeral: true }).catch(() => {});
            return;
          }

          const searchId = metiers.newSessionId();
          metiers.jobSearchSessions.set(searchId, {
            requesterId: interaction.user.id,
            jobKey: key,
            jobLabel: label,
            userIds: matches.map((m) => m.userId),
          });

          const slice = matches.slice(0, 3);
          const embeds = [];
          const components = [];
          for (const m of slice) {
            // eslint-disable-next-line no-await-in-loop
            const u = await interaction.client.users.fetch(m.userId).catch(() => null);
            if (!u) continue;
            const prof = users[m.userId] || {};
            const jobs = Array.isArray(prof.jobs) ? prof.jobs : [];
            // eslint-disable-next-line no-await-in-loop
            embeds.push(await metiers.buildUserJobsEmbed(u, jobs, { updatedAt: prof.updatedAt }));
            components.push(new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`mj:req:${searchId}:${m.userId}`).setLabel('📣 Demander un craft').setStyle(ButtonStyle.Primary)
            ));
          }

          const pageMax = Math.ceil(matches.length / 3);
          const nav = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mj:page:${searchId}:0`).setLabel('⬅️ Précédent').setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId(`mj:page:${searchId}:3`).setLabel('Suivant ➡️').setStyle(ButtonStyle.Secondary).setDisabled(pageMax <= 1),
          );
          components.push(nav);

          await interaction.followUp({ content: `Page 1/${pageMax} — **${label}**`, embeds, components, ephemeral: true }).catch(() => {});
          return;
        }

        // Dofusbook panel selects
        if (interaction.customId.startsWith('dbp:class:') || interaction.customId.startsWith('dbp:elem:') || interaction.customId.startsWith('dbp:delpick:')) {
          const parts = interaction.customId.split(':');
          const kind = parts[1];
          const guildId = parts[2];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

          if (kind === 'delpick') {
            if (!member || !isGtoOrDefMember(member, rc)) {
              return interaction.reply({ content: 'Réservé aux membres **GTO/DEF**.', ephemeral: true });
            }
            const buildId = Number(interaction.values?.[0]);
            if (!buildId) return interaction.reply({ content: 'Build invalide.', ephemeral: true });

            const row = db.prepare('SELECT * FROM dofusbook_builds WHERE guild_id=? AND id=?').get(guildId, buildId);
            if (!row || row.user_id !== interaction.user.id) {
              return interaction.reply({ content: 'Tu ne peux supprimer que tes propres builds.', ephemeral: true });
            }

            db.prepare('DELETE FROM dofusbook_builds WHERE guild_id=? AND id=? AND user_id=?').run(guildId, buildId, interaction.user.id);

            // refresh panel
            try {
              const rc2 = getConfigForGuild(guildId);
              if (rc2.dofusbookPanelChannelId) {
                const ch = await interaction.client.channels.fetch(rc2.dofusbookPanelChannelId).catch(() => null);
                if (ch && ch.isTextBased()) {
                  await ensureDofusbookPanel(interaction.guild, ch, rc2);
                }
              }
            } catch {}

            return interaction.update({ content: '🧹 Build supprimé.', embeds: [], components: [] }).catch(() => {});
          }

          // class/elem selection: store draft
          if (!member || !isGtoOrDefMember(member, rc)) {
            return interaction.reply({ content: 'Réservé aux membres **GTO/DEF**.', ephemeral: true });
          }

          if (kind === 'class') {
            const classKey = interaction.values?.[0];
            setDraft(guildId, interaction.user.id, { classKey });
            return interaction.reply({ content: `✅ Classe sélectionnée : **${DOFUS_TOUCH_CLASSES.find(c => c.key === classKey)?.label || classKey}**`, ephemeral: true });
          }
          if (kind === 'elem') {
            const elementKey = interaction.values?.[0];
            setDraft(guildId, interaction.user.id, { elementKey });
            return interaction.reply({ content: `✅ Élément sélectionné : **${DOFUS_TOUCH_ELEMENTS.find(e => e.key === elementKey)?.label || elementKey}**`, ephemeral: true });
          }
        }
      }

      if (interaction.isButton()) {
        // Métiers buttons
        if (interaction.customId === 'mj:open') {
          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          const profile = (db.users || {})[interaction.user.id] || {};
          const jobs = Array.isArray(profile.jobs) ? profile.jobs : [];
          const rows = metiers.buildManagePanelButtons(jobs.length > 0);
          return interaction.reply({
            content: [
              `**Métiers de ${interaction.user.username}**`,
              jobs.length ? jobs.map((j) => `• ${j.label} — niveau ${j.level}`).join('\n') : 'Aucun métier enregistré.',
            ].join('\n'),
            components: rows,
            ephemeral: true,
          }).catch(() => {});
        }

        if (interaction.customId === 'mj:add') {
          const catSel = new StringSelectMenuBuilder()
            .setCustomId('mj:add_cat')
            .setPlaceholder('Choisis une catégorie')
            .addOptions({ label: 'Métier', value: 'metier' }, { label: 'Forgemagie', value: 'forgemagie' });
          return interaction.reply({
            content: '➕ Ajouter / modifier : choisis une catégorie',
            components: [new ActionRowBuilder().addComponents(catSel)],
            ephemeral: true,
          }).catch(() => {});
        }

        if (interaction.customId === 'mj:del') {
          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          const profile = (db.users || {})[interaction.user.id] || {};
          const cur = Array.isArray(profile.jobs) ? profile.jobs : [];
          if (!cur.length) return interaction.reply({ content: "Tu n'as aucun métier enregistré.", ephemeral: true }).catch(() => {});

          const options = cur.slice(0, 25).map((j) => ({ label: j.label, value: j.key }));
          const sel = new StringSelectMenuBuilder()
            .setCustomId('mj:del_choose')
            .setPlaceholder('Quel métier supprimer ?')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options);

          return interaction.reply({
            content: 'Sélectionne le métier à supprimer :',
            components: [new ActionRowBuilder().addComponents(sel)],
            ephemeral: true,
          }).catch(() => {});
        }

        if (interaction.customId === 'mj:reset') {
          const yes = new ButtonBuilder().setCustomId('mj:reset_yes').setLabel('Oui, tout effacer').setStyle(ButtonStyle.Danger);
          const no = new ButtonBuilder().setCustomId('mj:reset_no').setLabel('Annuler').setStyle(ButtonStyle.Secondary);
          return interaction.reply({
            content: 'Confirme: tu veux effacer **tous** tes métiers ? (ta fiche sera mise à jour)',
            components: [new ActionRowBuilder().addComponents(yes, no)],
            ephemeral: true,
          }).catch(() => {});
        }

        if (interaction.customId === 'mj:reset_no') {
          return interaction.reply({ content: 'OK, annulé.', ephemeral: true }).catch(() => {});
        }

        if (interaction.customId === 'mj:reset_yes') {
          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          if (!db.users) db.users = {};
          const prev = db.users[interaction.user.id] || {};
          const messageId = prev.messageId || null;
          db.users[interaction.user.id] = { jobs: [], messageId, updatedAt: new Date().toISOString() };
          metiers.writeJsonAtomic(metiers.JOBS_USERS_PATH, db);

          try {
            const ch = await interaction.client.channels.fetch(metiers.CHANNEL_FICHES_PUBLIC).catch(() => null);
            if (ch && ch.isTextBased() && messageId) {
              const m = await ch.messages.fetch(messageId).catch(() => null);
              if (m) {
                const embed = await metiers.buildUserJobsEmbed(interaction.user, [], { updatedAt: db.users?.[interaction.user.id]?.updatedAt });
                await m.edit({ embeds: [embed] }).catch(() => {});
              }
            }
          } catch {}

          return interaction.reply({ content: '✅ Tous tes métiers ont été effacés.', ephemeral: true }).catch(() => {});
        }

        if (interaction.customId === 'mj:search') {
          const catSel = new StringSelectMenuBuilder()
            .setCustomId('mj:search_cat')
            .setPlaceholder('Choisis une catégorie')
            .addOptions({ label: 'Métier', value: 'metier' }, { label: 'Forgemagie', value: 'forgemagie' });
          return interaction.reply({
            content: '🔎 Recherche : choisis une catégorie',
            components: [new ActionRowBuilder().addComponents(catSel)],
            ephemeral: true,
          }).catch(() => {});
        }

        if (interaction.customId.startsWith('mj:page:')) {
          const parts = interaction.customId.split(':');
          const searchId = parts[2];
          const offset = Number(parts[3] || 0);

          const sess = metiers.jobSearchSessions.get(searchId);
          if (!sess) return interaction.reply({ content: 'Session expirée, relance une recherche.', ephemeral: true }).catch(() => {});
          if (sess.requesterId !== interaction.user.id) return interaction.reply({ content: 'Ce bouton ne t’appartient pas.', ephemeral: true }).catch(() => {});

          const db = metiers.readJsonSafe(metiers.JOBS_USERS_PATH, { version: 1, users: {} });
          const users = db.users || {};
          const slice = sess.userIds.slice(offset, offset + 3);

          const embeds = [];
          const components = [];
          for (const uid of slice) {
            // eslint-disable-next-line no-await-in-loop
            const u = await interaction.client.users.fetch(uid).catch(() => null);
            if (!u) continue;
            const prof = users[uid] || {};
            const jobs = Array.isArray(prof.jobs) ? prof.jobs : [];
            // eslint-disable-next-line no-await-in-loop
            embeds.push(await metiers.buildUserJobsEmbed(u, jobs, { updatedAt: prof.updatedAt }));
            components.push(new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`mj:req:${searchId}:${uid}`).setLabel('📣 Demander un craft').setStyle(ButtonStyle.Primary)
            ));
          }

          const prevDisabled = offset <= 0;
          const nextDisabled = offset + 3 >= sess.userIds.length;
          const nav = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mj:page:${searchId}:${Math.max(0, offset - 3)}`).setLabel('⬅️ Précédent').setStyle(ButtonStyle.Secondary).setDisabled(prevDisabled),
            new ButtonBuilder().setCustomId(`mj:page:${searchId}:${offset + 3}`).setLabel('Suivant ➡️').setStyle(ButtonStyle.Secondary).setDisabled(nextDisabled),
          );
          components.push(nav);

          const page = Math.floor(offset / 3) + 1;
          const pageMax = Math.ceil(sess.userIds.length / 3);

          return interaction.update({ content: `Page ${page}/${pageMax} — **${sess.jobLabel}**`, embeds, components }).catch(() => {});
        }

        if (interaction.customId.startsWith('mj:req:')) {
          const parts = interaction.customId.split(':');
          const searchId = parts[2];
          const targetId = parts[3];

          const sess = metiers.jobSearchSessions.get(searchId);
          if (!sess) return interaction.reply({ content: 'Session expirée, relance une recherche.', ephemeral: true }).catch(() => {});
          if (sess.requesterId !== interaction.user.id) return interaction.reply({ content: 'Ce bouton ne t’appartient pas.', ephemeral: true }).catch(() => {});

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member || !metiers.hasAnyAllowedRole(member)) {
            return interaction.reply({ content: 'Réservé aux rôles **Guildeux** ou **Invité**.', ephemeral: true }).catch(() => {});
          }

          const keyCooldown = `${interaction.user.id}:${targetId}`;
          const now = Date.now();
          const last = metiers.craftPingLast.get(keyCooldown) || 0;
          const wait = metiers.PING_COOLDOWN_MS - (now - last);
          if (wait > 0) {
            const sec = Math.ceil(wait / 1000);
            return interaction.reply({ content: `⏳ Attends encore ${sec}s avant de recontacter <@${targetId}>.`, ephemeral: true }).catch(() => {});
          }

          const ch = await interaction.client.channels.fetch(metiers.CHANNEL_PING_REQUESTS).catch((e) => {
            console.error('[metiers] fetch ping channel failed:', e);
            return null;
          });
          if (!ch || !ch.isTextBased()) {
            return interaction.reply({ content: 'Salon de demandes introuvable (ou inaccessible).', ephemeral: true }).catch(() => {});
          }

          const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
          if (isThread && typeof ch.join === 'function') {
            await ch.join().catch(() => {});
          }

          let sent = await ch.send({
            content: `📣 <@${targetId}> — <@${interaction.user.id}> cherche un craft : **${sess.jobLabel}**. Tu es dispo ?`,
            allowedMentions: { users: [targetId, interaction.user.id] },
          }).catch((e) => {
            console.error('[metiers] failed to send ping request:', e);
            return null;
          });

          // If the thread was archived, try to unarchive then send again.
          if (!sent && isThread) {
            const canUnarchive = Boolean(ch.archived);
            if (canUnarchive) {
              await ch.setArchived(false).catch((e) => console.error('[metiers] failed to unarchive thread:', e));
              sent = await ch.send({
                content: `📣 <@${targetId}> — <@${interaction.user.id}> cherche un craft : **${sess.jobLabel}**. Tu es dispo ?`,
                allowedMentions: { users: [targetId, interaction.user.id] },
              }).catch((e) => {
                console.error('[metiers] failed to send ping request (after unarchive):', e);
                return null;
              });
            }
          }

          if (!sent) {
            return interaction.reply({
              content: '❌ Impossible d’envoyer la demande dans le salon dédié (permissions manquantes ?).',
              ephemeral: true,
            }).catch(() => {});
          }

          // only start cooldown if message was sent
          metiers.craftPingLast.set(keyCooldown, now);

          return interaction.reply({ content: '✅ Demande envoyée.', ephemeral: true }).catch(() => {});
        }

        if (interaction.customId.startsWith('mj:pubreq:')) {
          const parts = interaction.customId.split(':');
          const targetId = parts[2];

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member || !metiers.hasAnyAllowedRole(member)) {
            return interaction.reply({ content: 'Réservé aux rôles **Guildeux** ou **Invité**.', ephemeral: true }).catch(() => {});
          }

          const keyCooldown = `${interaction.user.id}:${targetId}`;
          const now = Date.now();
          const last = metiers.craftPingLast.get(keyCooldown) || 0;
          const wait = metiers.PING_COOLDOWN_MS - (now - last);
          if (wait > 0) {
            const sec = Math.ceil(wait / 1000);
            return interaction.reply({ content: `⏳ Attends encore ${sec}s avant de recontacter <@${targetId}>.`, ephemeral: true }).catch(() => {});
          }
          const ch = await interaction.client.channels.fetch(metiers.CHANNEL_PING_REQUESTS).catch((e) => {
            console.error('[metiers] fetch ping channel failed:', e);
            return null;
          });
          if (!ch || !ch.isTextBased()) {
            return interaction.reply({ content: 'Salon de demandes introuvable (ou inaccessible).', ephemeral: true }).catch(() => {});
          }

          const isThread = typeof ch.isThread === 'function' ? ch.isThread() : false;
          if (isThread && typeof ch.join === 'function') {
            await ch.join().catch(() => {});
          }

          let sent = await ch.send({
            content: `📣 <@${targetId}> — <@${interaction.user.id}> cherche un craft. Tu es dispo ?`,
            allowedMentions: { users: [targetId, interaction.user.id] },
          }).catch((e) => {
            console.error('[metiers] failed to send ping request:', e);
            return null;
          });

          // If the thread was archived, try to unarchive then send again.
          if (!sent && isThread) {
            const canUnarchive = Boolean(ch.archived);
            if (canUnarchive) {
              await ch.setArchived(false).catch((e) => console.error('[metiers] failed to unarchive thread:', e));
              sent = await ch.send({
                content: `📣 <@${targetId}> — <@${interaction.user.id}> cherche un craft. Tu es dispo ?`,
                allowedMentions: { users: [targetId, interaction.user.id] },
              }).catch((e) => {
                console.error('[metiers] failed to send ping request (after unarchive):', e);
                return null;
              });
            }
          }

          if (!sent) {
            return interaction.reply({
              content: '❌ Impossible d’envoyer la demande dans le salon dédié (permissions manquantes ?).',
              ephemeral: true,
            }).catch(() => {});
          }

          // only start cooldown if message was sent
          metiers.craftPingLast.set(keyCooldown, now);

          return interaction.reply({ content: '✅ Demande envoyée.', ephemeral: true }).catch(() => {});
        }

        // Stuff generator button
        if (interaction.customId.startsWith('gs:regen:')) {
          try {
            if (interaction.channelId !== STUFF_GEN_CHANNEL_ID) {
              return interaction.reply({ content: `Utilise le générateur uniquement dans <#${STUFF_GEN_CHANNEL_ID}>.`, ephemeral: true });
            }

            // ACK immediately (prevents "Unknown interaction" if any processing takes time)
            await interaction.deferUpdate().catch(() => {});

            const [_, __, sessionId] = interaction.customId.split(':');
            const state = stuffSessions.get(sessionId);
            if (!state) {
              return interaction.followUp({ content: 'Session expirée. Demande à un admin de relancer /generateurstuff.', ephemeral: true }).catch(() => {});
            }

            let items;
            try {
              ({ items } = stuffGen.loadCatalog());
            } catch (e) {
              return interaction.followUp({
                content: `Catalogue introuvable/corrompu. (${e?.message || e})`,
                ephemeral: true,
              }).catch(() => {});
            }

            const filtered = stuffGen.filterItems(items, state.criteria);

            const perUserKey = `${sessionId}:${interaction.user.id}`;
            const perUser = stuffSessions.get(perUserKey) || { alreadyShown: new Set(), generatedOnce: false };
            if (!(perUser.alreadyShown instanceof Set)) perUser.alreadyShown = new Set();

            const list = stuffGen.pick10(filtered, perUser.alreadyShown);
            list.forEach((x) => perUser.alreadyShown.add(String(x.stuff_id)));
            perUser.generatedOnce = true;
            stuffSessions.set(perUserKey, perUser);

            const embed = stuffGen.buildResultsEmbed(list, state.criteria);

            // Keep dashboard message clean (edit the original message)
            const components = stuffGen.buildUI(sessionId, state.criteria, { regenLabel: '⟲ Autres 10' });
            await interaction.editReply({
              content: [
                '**Générateur de stuff — Dashboard**',
                `Sélection: element=${state.criteria.element || '—'} | PA=${state.criteria.pa || '—'} | PM=${state.criteria.pm || '—'}`,
                'Clique sur **⟲ Autres 10** pour voir d\'autres propositions.',
              ].join('\n'),
              components,
            }).catch(() => {});

            // Results in ephemeral with a single "Autres 10" button
            return interaction.followUp({
              embeds: [embed],
              components: stuffGen.buildRegenOnlyRow(sessionId, { label: '⟲ Autres 10' }),
              ephemeral: true,
            }).catch(() => {});
          } catch (e) {
            console.error('[stuff] regen error:', e);
            return interaction.followUp({ content: `Erreur interne: ${(e?.message || e)}`.slice(0, 1500), ephemeral: true }).catch(() => {});
          }
        }

        // Dofusbook builds panel
        if (interaction.customId.startsWith('dbp:add:') || interaction.customId.startsWith('dbp:mine:')) {
          const guildId = interaction.customId.split(':')[2];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          if (rc.dofusbookPanelChannelId && interaction.channelId !== rc.dofusbookPanelChannelId) {
            return interaction.reply({ content: `Utilise ce panneau uniquement dans <#${rc.dofusbookPanelChannelId}>.`, ephemeral: true });
          }

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member || !isGtoOrDefMember(member, rc)) {
            return interaction.reply({ content: 'Réservé aux membres **GTO/DEF**.', ephemeral: true });
          }

          if (interaction.customId.startsWith('dbp:add:')) {
            const draft = getDraft(guildId, interaction.user.id);
            const modal = new ModalBuilder()
              .setCustomId(`dbp:add_submit:${guildId}`)
              .setTitle('Ajouter un build Dofusbook');

            const inputName = new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Nom du build (ex: PVM 130, PVP tank...)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(40);

            const inputLevel = new TextInputBuilder()
              .setCustomId('level')
              .setLabel('Niveau (1-200)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(3)
              .setValue('200');

            const inputUrl = new TextInputBuilder()
              .setCustomId('url')
              .setLabel('Lien Dofusbook')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('https://...dofusbook...');

            modal.addComponents(
              new ActionRowBuilder().addComponents(inputName),
              new ActionRowBuilder().addComponents(inputLevel),
              new ActionRowBuilder().addComponents(inputUrl),
            );

            // Store draft selections in modal via runtime map (we will read from it on submit)
            setDraft(guildId, interaction.user.id, { classKey: draft.classKey, elementKey: draft.elementKey });
            return interaction.showModal(modal);
          }

          if (interaction.customId.startsWith('dbp:mine:')) {
            const rows = db.prepare('SELECT * FROM dofusbook_builds WHERE guild_id=? AND user_id=? ORDER BY level DESC, created_at DESC').all(guildId, interaction.user.id);
            if (!rows.length) {
              return interaction.reply({ content: 'Tu n\'as encore aucun build publié.', ephemeral: true });
            }

            const opts = rows.slice(0, 25).map(r => {
              const cls = DOFUS_TOUCH_CLASSES.find(c => c.key === r.class_key)?.label || r.class_key;
              const el = DOFUS_TOUCH_ELEMENTS.find(e => e.key === r.element_key)?.label || r.element_key;
              return {
                label: `${r.build_name}`.slice(0, 80),
                description: `${cls} • ${el} • lvl ${r.level}`.slice(0, 100),
                value: String(r.id),
              };
            });

            const embed = new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle('🧩 Mes builds Dofusbook')
              .setDescription(rows.slice(0, 10).map(renderBuildLine).join('\n').slice(0, 3900));

            const row = new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`dbp:delpick:${guildId}`)
                .setPlaceholder('Sélectionner un build à supprimer')
                .addOptions(opts)
            );
            return interaction.reply({ embeds: [embed], components: [row], ephemeral: true, allowedMentions: { parse: [] } });
          }
        }

        // Ankama profile panel
        if (interaction.customId.startsWith('ankprof:open:')) {
          const guildId = interaction.customId.split(':')[2];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          if (rc.ankamaProfileChannelId && interaction.channelId !== rc.ankamaProfileChannelId) {
            return interaction.reply({ content: `Utilise ce panneau uniquement dans <#${rc.ankamaProfileChannelId}>.`, ephemeral: true });
          }

          const modal = new ModalBuilder()
            .setCustomId(`ankprof:submit:${guildId}`)
            .setTitle('Ouvrir un profil Ankama');

          const input = new TextInputBuilder()
            .setCustomId('tag')
            .setLabel('Pseudo Ankama (format jeu)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
            .setPlaceholder('pseudo#1234')
            .setValue('pseudo#1234');

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        // Events Perco — validation buttons
        if (interaction.customId.startsWith('evval:')) {
          try {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            const parts = interaction.customId.split(':');
            const id = Number(parts[1]);
            const action = parts[2];

            const rc = getConfigForGuild(interaction.guild.id);
            const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
            if (!allowed) return interaction.editReply({ content: 'Réservé staff.' }).catch(() => {});

            const sub = ev.getSubmission(id);
            if (!sub) return interaction.editReply({ content: 'Demande introuvable.' }).catch(() => {});

            if (action === 'editparts') {
              const modal = new ModalBuilder().setCustomId(`evparts:${id}`).setTitle('Modifier participants');
              const input = new TextInputBuilder()
                .setCustomId('participants')
                .setLabel('Mentions ou IDs (séparés par espaces/retours)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(800)
                .setValue(String(sub.participants_override || '').trim() || String(sub.participants || '').split(',').filter(Boolean).map(id2 => `<@${id2}>`).join(' '));
              modal.addComponents(new ActionRowBuilder().addComponents(input));
              // can't show modal after deferReply; use showModal directly
              await interaction.deleteReply().catch(() => {});
              return interaction.showModal(modal);
            }

            if (action === 'approve') {
              if (sub.status !== 'pending') return interaction.editReply({ content: 'Déjà traité.' }).catch(() => {});

              const defenders = Number(sub.defenders_present);
              if (!defenders || defenders < 1 || defenders > 5) {
                return interaction.editReply({ content: 'Choisis d’abord le nombre de défenseurs (1-5).' }).catch(() => {});
              }

              const baseList = String(sub.participants_override || sub.participants || '');
              const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
              if (!participantIds.length) return interaction.editReply({ content: 'Aucun participant.' }).catch(() => {});

              // Anti-spam: claim atomically
              const claimed = ev.claimForApply(id, interaction.user.id);
              if (!claimed) return interaction.editReply({ content: 'â³ Déjà en cours de traitement (ou déjà validé).' }).catch(() => {});

              // Apply awards (idempotent per submission)
              try { ev.clearAwards(sub.guild_id, id); } catch {}
              ev.applyAwards(sub.guild_id, id, participantIds, defenders);
              ev.markApproved(id, { points: defenders, validatedBy: interaction.user.id });

              // Post/update outputs
              try {
                await postOfficialEventResult(interaction.guild, rc, sub, { status: 'approved', defenders, participantIds, validatedBy: interaction.user.id }).catch(() => {});
                await postEventScreen(interaction.guild, rc, sub, { status: 'approved', defenders, participantIds, validatedBy: interaction.user.id }).catch(() => {});
                await closeEventThread(interaction.guild, sub).catch(() => {});
              } catch {}

              await ensureEventScoreboard(interaction.guild, rc).catch(() => {});

              // Keep only essential post-validation controls: correction + resync
              try {
                const rowAfter = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`evfix:${id}:open`).setLabel('🔧 Corriger').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId(`evpub:${id}:resync`).setLabel('🔄 Resync').setStyle(ButtonStyle.Secondary),
                );
                await interaction.message.edit({ components: [rowAfter] }).catch(() => {});
              } catch {}

              return interaction.editReply({ content: `✅ Validé : +${defenders} pts à ${participantIds.length} joueur(s).` }).catch(() => {});
            }

            if (action === 'deny') {
              // can't show modal after deferReply; show modal directly
              await interaction.deleteReply().catch(() => {});
              const modal = new ModalBuilder().setCustomId(`evdeny:${id}`).setTitle('Refuser la preuve');
              const input = new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Raison du refus (obligatoire)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(400)
                .setPlaceholder('Ex: heure/date non visible, participants incomplets, screen flou…');
              modal.addComponents(new ActionRowBuilder().addComponents(input));
              return interaction.showModal(modal);
            }

            return interaction.editReply({ content: 'Action inconnue.' }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `❌ Erreur: ${(e?.message || e)}`.slice(0, 1800) }).catch(() => {});
          }
        }

        // Events Perco — open submission (create thread)
        if (interaction.customId.startsWith('evopen:')) {
          try {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            const guildId = interaction.customId.split(':')[1];
            if (!interaction.guild || interaction.guild.id !== guildId) {
              return interaction.editReply({ content: 'Action invalide.' }).catch(() => {});
            }

            const rc = getConfigForGuild(guildId);
            if (!rc.eventProofsChannelId) return interaction.editReply({ content: 'Events non configurés.' }).catch(() => {});

            const proofsCh = await interaction.client.channels.fetch(rc.eventProofsChannelId).catch(() => null);
            if (!proofsCh || !proofsCh.isTextBased()) return interaction.editReply({ content: 'Salon preuves inaccessible.' }).catch(() => {});

            const threadName = `combat-${interaction.user.username}-${new Date().toISOString().slice(11, 16)}`;
            const thread = await proofsCh.threads.create({
              name: threadName.slice(0, 90),
              autoArchiveDuration: 1440,
              type: ChannelType.PublicThread,
              reason: 'Soumission événement perco',
            });

            drafts.setDraft({ guildId, authorId: interaction.user.id, threadId: thread.id, participants: '', stage: 'need_participants' });

            await thread.send({
              content:
                `${interaction.user} — **Étape 1/2 :** mentionne maintenant les participants (**@personnes**) dans ce thread.\n` +
                `Ex: @A @B @C @D @E`,
              allowedMentions: { users: [interaction.user.id], parse: [] },
            });

            return interaction.editReply({ content: `✅ Thread créé : <#${thread.id}>` }).catch(() => {});
          } catch (e) {
            return interaction.editReply({ content: `❌ Impossible de créer le thread. Vérifie mes permissions dans le salon preuves (Créer des threads / Envoyer messages / Voir salon).\nDétail: ${(e?.message || e)}`.slice(0, 1900) }).catch(() => {});
          }
        }

        // Rules acceptance button
        if (interaction.customId.startsWith('rulesok:')) {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.editReply({ content: 'Action invalide.' }).catch(() => {});
          }
          if (interaction.user.id !== targetUserId) {
            return interaction.editReply({ content: "Ce bouton est réservé au nouveau membre." }).catch(() => {});
          }

          const rc = getConfigForGuild(interaction.guild.id);
          if (!rc.rulesAccessRoleId) {
            return interaction.editReply({ content: "Règlement non configuré (role_acces manquant)." }).catch(() => {});
          }

          // Add access role
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.editReply({ content: "Je n'ai pas la permission **Gérer les rôles**." }).catch(() => {});
          }

          const accessRole = interaction.guild.roles.cache.get(rc.rulesAccessRoleId);
          if (!accessRole) return interaction.editReply({ content: "Rôle d'accès introuvable." }).catch(() => {});

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member) return interaction.editReply({ content: 'Impossible de te récupérer.' }).catch(() => {});

          try {
            await member.roles.add(accessRole);
          } catch (e) {
            return interaction.editReply({ content: `Erreur rôle: ${e.message}` }).catch(() => {});
          }

          // Send welcome message now (arrival step)
          if (!rc.welcomeChannelId) {
            return interaction.editReply({ content: '✅ Règlement validé. (Salon arrivée non configuré)' }).catch(() => {});
          }

          const ch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
          if (!ch || !ch.isTextBased()) {
            return interaction.editReply({ content: '✅ Règlement validé. (Salon arrivée inaccessible)' }).catch(() => {});
          }

          // Build welcome message
          // (GIF welcome system removed: keep the welcome message clean and consistent)

          const avatarUrl = member.user.displayAvatarURL?.({ size: 1024 });

          // Embed 1: big avatar (Discord thumbnail is small, so we use a full image)
          const avatarEmbed = new EmbedBuilder()
            .setColor(0x2c3e50)
            .setTitle(`🆕 ${member.user.tag || member.user.username}`)
            .setDescription(`Profil de ${member} (ID: ${member.id})`)
            .setImage(avatarUrl);

          // Embed 2: welcome text + optional GIF banner
          const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setAuthor({ name: `Nouvel arrivant`, iconURL: member.user.displayAvatarURL?.({ size: 256 }) })
            .setTitle('👋 Bienvenue parmi nous !')
            .setDescription(
              `✨ ${member} rejoint la guilde **${rc.welcomeGuildName || 'GTO'}** !\n\n` +
              `Ici c’est **fraternité**, **entraide** et **bonne ambiance**.\n` +
              `Passe dire bonjour et installe-toi tranquillement.`
            )
            .addFields(
              { name: '✅ Étape suivante', value: 'Choisis ci-dessous si tu es **Guildeux** ou **Invité**.', inline: false },
              {
                name: '🛡️ Vérification staff',
                value: 'Après tes choix, un membre du staff vérifiera ton adhésion. Si tu es bien un membre de la guilde, les rôles **GTO** et **DEF** te seront attribués pour être notifié de l’activité.',
                inline: false,
              },
            )
            .setFooter({ text: 'Bienvenue à toi.' });

          const components = [];
          if (rc.welcomeRoleGuildeuxId || rc.welcomeRoleInviteId) {
            const row = new ActionRowBuilder();
            if (rc.welcomeRoleGuildeuxId) {
              row.addComponents(
                new ButtonBuilder()
                  .setCustomId(`welrole:${member.guild.id}:${member.user.id}:guildeux`)
                  .setLabel('🛡️ Je suis Guildeux')
                  .setStyle(ButtonStyle.Primary)
              );
            }
            if (rc.welcomeRoleInviteId) {
              row.addComponents(
                new ButtonBuilder()
                  .setCustomId(`welrole:${member.guild.id}:${member.user.id}:invite`)
                  .setLabel('🎟️ Je suis Invité')
                  .setStyle(ButtonStyle.Secondary)
              );
            }
            components.push(row);
          }


          const files = [];

          // Custom thumbnail (replaces the small member avatar now that we show it big)
          try {
            const thumbPath = path.join(__dirname, '..', 'assets', 'welcome-thumb.png');
            files.push({ attachment: thumbPath, name: 'welcome-thumb.png' });
            embed.setThumbnail('attachment://welcome-thumb.png');
          } catch {}


          // IMPORTANT: never ping @everyone during onboarding.
          const sentWelcome = await ch.send({
            content: '',
            embeds: [avatarEmbed, embed],
            components,
            files,
            allowedMentions: { parse: [] },
          });

          // Track the welcome message to enable GIF button after staff validation
          try {
            db.prepare(
              `INSERT INTO welcome_state (guild_id, user_id, welcome_message_id, joined_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(guild_id, user_id) DO UPDATE SET welcome_message_id=excluded.welcome_message_id, joined_at=excluded.joined_at`
            ).run(interaction.guild.id, member.user.id, sentWelcome.id, Number(member.joinedTimestamp) || Date.now());
          } catch {}

          // Remove the prompt message entirely after success (less visible to others)
          try { await interaction.message.delete(); } catch {}

          // React on the rules message (thumbs up)
          try {
            if (rc.rulesChannelId && rc.rulesMessageId) {
              const rch = await interaction.client.channels.fetch(rc.rulesChannelId).catch(() => null);
              if (rch && rch.isTextBased()) {
                const rm = await rch.messages.fetch(rc.rulesMessageId).catch(() => null);
                if (rm) await rm.react('👍🏽').catch(() => {});
              }
            }
          } catch {}

          // Ack + link to the next step
          try {
            await interaction.editReply({
              content: `✅ Règlement validé. Accès débloqué via ${accessRole}.\n➡️ Suite : va dans <#${rc.welcomeChannelId}> pour choisir **Guildeux** ou **Invité**.`,
            }).catch(() => {});
          } catch {}

          return;
        }

        // Profile edit button (staff only)
        if (interaction.customId.startsWith('profedit:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé Meneur / Bras droit.', ephemeral: true });

          const current = profiles.getProfile(guildId, targetUserId);
          const modal = new ModalBuilder()
            .setCustomId(`profset:${guildId}:${targetUserId}:${interaction.message.id}`)
            .setTitle('Modifier pseudos en jeu');

          const input = new TextInputBuilder()
            .setCustomId('pseudos')
            .setLabel('Pseudos (un par ligne)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(800)
            .setValue(String(current?.ign || '').slice(0, 800));

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        // Events Perco — correction workflow (preview only for corrections)
        if (interaction.customId.startsWith('evfix:')) {
          const parts = interaction.customId.split(':');
          const sid = Number(parts[1]);
          const action = parts[2];

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          if (action === 'open') {
            const modal = new ModalBuilder().setCustomId(`evfix_submit:${sid}`).setTitle(`Correction SID ${sid}`);

            const defenders = new TextInputBuilder()
              .setCustomId('defenders')
              .setLabel('Défenseurs présents (1-5)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(1)
              .setValue(String(sub.defenders_present || ''));

            const participants = new TextInputBuilder()
              .setCustomId('participants')
              .setLabel('Participants (mentions ou IDs)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(800)
              .setValue(String(sub.participants_override || '').trim() || String(sub.participants || '').split(',').filter(Boolean).map(id2 => `<@${id2}>`).join(' '));

            modal.addComponents(new ActionRowBuilder().addComponents(defenders), new ActionRowBuilder().addComponents(participants));
            return interaction.showModal(modal);
          }

          return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
        }

        // Events Perco — per-publication staff controls (scoped to a submission)
        if (interaction.customId.startsWith('evpub:')) {
          const parts = interaction.customId.split(':');
          const sid = Number(parts[1]);
          const action = parts[2];

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });

          const baseList = String(sub.participants_override || sub.participants || '');
          const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
          const preview = participantIds.slice(0, 5).map(id => `<@${id}>`).join(' ');

          if (action === 'resync') {
            try {
              await ensureEventScoreboard(interaction.guild, rc);
              return interaction.reply({ content: '🔄 Refresh OK (scoreboard mis à jour).', ephemeral: true });
            } catch (e) {
              return interaction.reply({ content: `❌ Refresh impossible. Vérifie mes permissions dans le salon classement (Voir salon / Envoyer messages / Lire historique / Épingler si possible).\nDétail: ${(e?.message || e)}`.slice(0, 1900), ephemeral: true });
            }
          }

          if (action === 'add') {
            const modal = new ModalBuilder().setCustomId(`evpub_add_submit:${sid}`).setTitle('âž• Points (ce combat)');
            const d = new TextInputBuilder().setCustomId('delta').setLabel('Delta points (ex: 5 ou -3)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16);
            const note = new TextInputBuilder().setCustomId('note').setLabel('Participants (auto) — laisse tel quel').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(preview || '—');
            modal.addComponents(new ActionRowBuilder().addComponents(d), new ActionRowBuilder().addComponents(note));
            return interaction.showModal(modal);
          }

          if (action === 'set') {
            const modal = new ModalBuilder().setCustomId(`evpub_set_submit:${sid}`).setTitle('âœï¸ Fixer points (ce combat)');
            const p = new TextInputBuilder().setCustomId('points').setLabel('Points EXACTS à définir (>=0)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16);
            const note = new TextInputBuilder().setCustomId('note').setLabel('Participants (auto) — laisse tel quel').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(preview || '—');
            modal.addComponents(new ActionRowBuilder().addComponents(p), new ActionRowBuilder().addComponents(note));
            return interaction.showModal(modal);
          }

          if (action === 'remove') {
            const modal = new ModalBuilder().setCustomId(`evpub_remove_submit:${sid}`).setTitle('🧹 Kick du classement');
            const u = new TextInputBuilder().setCustomId('user').setLabel('Joueur à retirer (mention ou ID)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
            modal.addComponents(new ActionRowBuilder().addComponents(u));
            return interaction.showModal(modal);
          }

          return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
        }

        // Events Perco — apply/cancel correction preview actions
        if (interaction.customId.startsWith('evfixapply:')) {
          const parts = interaction.customId.split(':');
          const sid = Number(parts[1]);
          const action = parts[2];

          if (action === 'cancel') {
            pendingEventFix.delete(`${interaction.user.id}:${sid}`);
            return interaction.reply({ content: 'Annulé.', ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const plan = pendingEventFix.get(`${interaction.user.id}:${sid}`);
          if (!plan) return interaction.reply({ content: 'Plan de correction introuvable (refais 🔧 Corriger).', ephemeral: true });

          const sub = ev.getSubmission(sid);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
          if (sub.status !== 'approved') return interaction.reply({ content: 'Correction possible uniquement après validation.', ephemeral: true });

          const claimed = ev.claimForFix(sid, interaction.user.id);
          if (!claimed) return interaction.reply({ content: 'â³ Déjà en cours de correction (ou statut invalide).', ephemeral: true });

          // Apply correction: rollback old award, apply new award
          try { ev.clearAwards(sub.guild_id, sid); } catch {}
          ev.applyAwards(sub.guild_id, sid, plan.participantIds, plan.defenders);

          // Persist the correction on the submission for traceability
          try { ev.setParticipantsOverride(sid, plan.participantIds.join(',')); } catch {}
          try { ev.setDefendersPresent(sid, plan.defenders); } catch {}

          // Back to approved
          ev.markApproved(sid, { points: plan.defenders, validatedBy: interaction.user.id });

          // Update outputs
          try {
            await postEventScreen(interaction.guild, rc, sub, {
              status: 'approved',
              defenders: plan.defenders,
              participantIds: plan.participantIds,
              validatedBy: interaction.user.id,
            }).catch(() => {});
          } catch {}

          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});

          pendingEventFix.delete(`${interaction.user.id}:${sid}`);
          return interaction.reply({ content: '✅ Correction appliquée (scoreboard + screens synchronisés).', ephemeral: true });
        }

        // Events Perco — apply/cancel preview actions
        if (interaction.customId.startsWith('evapply:')) {
          const parts = interaction.customId.split(':');
          const id = Number(parts[1]);
          const action = parts[2];

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          if (action === 'cancel') {
            return interaction.reply({ content: 'Annulé.', ephemeral: true });
          }

          const sub = ev.getSubmission(id);
          if (!sub) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
          if (sub.status !== 'pending') return interaction.reply({ content: 'Déjà traité.', ephemeral: true });

          // Claim to prevent double apply (double-click / two staff)
          const claimed = ev.claimForApply(id, interaction.user.id);
          if (!claimed) {
            return interaction.reply({ content: 'â³ Déjà en cours de traitement (ou déjà validé).', ephemeral: true });
          }

          const defenders = Number(sub.defenders_present);
          const baseList = String(sub.participants_override || sub.participants || '');
          const participantIds = baseList.split(',').map(s => s.trim()).filter(Boolean);
          if (!defenders || defenders < 1 || defenders > 5) return interaction.reply({ content: 'Défenseurs non définis.', ephemeral: true });
          if (!participantIds.length) return interaction.reply({ content: 'Aucun participant.', ephemeral: true });

          // Rollback previous awards for this submission (safety), then apply new awards
          try { ev.clearAwards(sub.guild_id, id); } catch {}
          ev.applyAwards(sub.guild_id, id, participantIds, defenders);

          ev.markApproved(id, { points: defenders, validatedBy: interaction.user.id });

          // Update pending reply under the player's message
          try {
            const proofsCh = await interaction.client.channels.fetch(sub.proofs_channel_id).catch(() => null);
            if (proofsCh && proofsCh.isTextBased() && sub.pending_reply_message_id) {
              const msg = await proofsCh.messages.fetch(sub.pending_reply_message_id).catch(() => null);
              if (msg) {
                const embed = new EmbedBuilder()
                  .setColor(0x2ecc71)
                  .setTitle('✅ Validé')
                  .setDescription(`Validé par <@${interaction.user.id}> — **+${defenders} pts** / joueur`)
                  .addFields({ name: 'Participants', value: participantIds.map(u => `<@${u}>`).join(' '), inline: false })
                  .setTimestamp();
                await msg.edit({ embeds: [embed] }).catch(() => {});
              }
            }
          } catch {}

          // Post official result + screens + close thread
          try {
            await postOfficialEventResult(interaction.guild, rc, sub, {
              status: 'approved',
              defenders,
              participantIds,
              validatedBy: interaction.user.id,
            }).catch(() => {});

            await postEventScreen(interaction.guild, rc, sub, {
              status: 'approved',
              defenders,
              participantIds,
              validatedBy: interaction.user.id,
            }).catch(() => {});

            await closeEventThread(interaction.guild, sub).catch(() => {});
          } catch {}

          await ensureEventScoreboard(interaction.guild, rc).catch(() => {});

          // Disable buttons on the staff message to avoid re-apply spam
          try {
            const vch = await interaction.client.channels.fetch(rc.eventValidationChannelId).catch(() => null);
            if (vch && vch.isTextBased() && sub.staff_message_id) {
              const staffMsg = await vch.messages.fetch(sub.staff_message_id).catch(() => null);
              if (staffMsg) {
                await staffMsg.edit({ components: [] }).catch(() => {});
              }
            }
          } catch {}

          return interaction.reply({ content: `✅ Appliqué : +${defenders} pts à ${participantIds.length} joueur(s).`, ephemeral: true });
        }

        // Events Perco — staff admin panel
        if (interaction.customId.startsWith('evadm:')) {
          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const allowed = !!(clicker && (rc.validationStaffRoleIds || []).some(rid => clicker.roles.cache.has(rid)));
          if (!allowed) return interaction.reply({ content: 'Réservé staff.', ephemeral: true });

          const action = interaction.customId.split(':')[1];
          if (action === 'resync') {
            try {
              await ensureEventScoreboard(interaction.guild, rc);
              return interaction.reply({ content: '🔄 Resync terminé (classement mis à jour).', ephemeral: true });
            } catch (e) {
              return interaction.reply({ content: `❌ Resync impossible. Vérifie mes permissions dans le salon classement.\nDétail: ${(e?.message || e)}`.slice(0, 1900), ephemeral: true });
            }
          }

          if (action === 'add') {
            const modal = new ModalBuilder().setCustomId('evadm_add_submit').setTitle('Add points (delta)');
            const u = new TextInputBuilder().setCustomId('user').setLabel('Joueur (mention ou ID)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
            const d = new TextInputBuilder().setCustomId('delta').setLabel('Delta points (ex: 5 ou -3)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16);
            modal.addComponents(new ActionRowBuilder().addComponents(u), new ActionRowBuilder().addComponents(d));
            return interaction.showModal(modal);
          }

          if (action === 'set') {
            const modal = new ModalBuilder().setCustomId('evadm_set_submit').setTitle('Set points (absolu)');
            const u = new TextInputBuilder().setCustomId('user').setLabel('Joueur (mention ou ID)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
            const p = new TextInputBuilder().setCustomId('points').setLabel('Points (ex: 42)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16);
            modal.addComponents(new ActionRowBuilder().addComponents(u), new ActionRowBuilder().addComponents(p));
            return interaction.showModal(modal);
          }

          if (action === 'remove') {
            const modal = new ModalBuilder().setCustomId('evadm_remove_submit').setTitle('Remove player du classement');
            const u = new TextInputBuilder().setCustomId('user').setLabel('Joueur à supprimer (mention ou ID)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64);
            modal.addComponents(new ActionRowBuilder().addComponents(u));
            return interaction.showModal(modal);
          }

          if (action === 'reset') {
            const modal = new ModalBuilder().setCustomId('evadm_reset_submit').setTitle('🧨 Reset saison Events');
            const input = new TextInputBuilder()
              .setCustomId('confirm')
              .setLabel('Tape RESET pour confirmer')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(16)
              .setPlaceholder('RESET');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
          }

          return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
        }



        // Staff validation buttons
        if (interaction.customId.startsWith('staffval:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];
          // Backward compatible:
          // old: staffval:guildId:userId:approve
          // new: staffval:guildId:userId:(guildeux|invite):approve
          const mode = parts.length >= 5 ? parts[3] : 'guildeux';
          const action = parts.length >= 5 ? parts[4] : parts[3];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          const clicker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const isStaff = !!(clicker && rc.validationStaffRoleIds?.some(rid => clicker.roles.cache.has(rid)));
          if (!isStaff) {
            return interaction.reply({ content: "Réservé au staff.", ephemeral: true });
          }

          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.reply({ content: "Je n'ai pas la permission **Gérer les rôles**.", ephemeral: true });
          }

          const target = await interaction.guild.members.fetch(targetUserId).catch(() => null);
          if (!target) return interaction.reply({ content: 'Membre introuvable.', ephemeral: true });

          const roleGTO = rc.validationGtoRoleId ? interaction.guild.roles.cache.get(rc.validationGtoRoleId) : null;
          const roleDEF = rc.validationDefRoleId ? interaction.guild.roles.cache.get(rc.validationDefRoleId) : null;
          const roleGuildeux = rc.welcomeRoleGuildeuxId ? interaction.guild.roles.cache.get(rc.welcomeRoleGuildeuxId) : null;
          const roleInvite = rc.welcomeRoleInviteId ? interaction.guild.roles.cache.get(rc.welcomeRoleInviteId) : null;

          try {
            if (mode === 'invite') {
              if (action === 'approve') {
                // Validate as invite: ensure invite role, remove guild roles if any
                if (roleInvite) await target.roles.add(roleInvite).catch(() => {});
                if (roleGuildeux) await target.roles.remove(roleGuildeux).catch(() => {});
                if (roleGTO) await target.roles.remove(roleGTO).catch(() => {});
                if (roleDEF) await target.roles.remove(roleDEF).catch(() => {});

                await updateProfileBox(interaction.guild, rc, targetUserId, {
                  statusText: `✅ Invité validé — ${roleInvite ? roleInvite.toString() : 'Invité'}`,
                });

                // Enable GIF button + auto-send first GIF (with @everyone) once validated
                try {
                  const ws = db.prepare('SELECT welcome_message_id, joined_at, first_gif_sent_at FROM welcome_state WHERE guild_id=? AND user_id=?').get(guildId, targetUserId);
                  if (ws?.welcome_message_id && rc.welcomeChannelId) {
                    const wch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
                    if (wch && wch.isTextBased()) {
                      const wm = await wch.messages.fetch(ws.welcome_message_id).catch(() => null);
                      if (wm) {
                        const row = new ActionRowBuilder().addComponents(
                          new ButtonBuilder()
                            .setCustomId(`welgif:${guildId}:${targetUserId}:${Number(ws.joined_at || target.joinedTimestamp || Date.now())}`)
                            .setLabel('🎉 Souhaiter la bienvenue (GIF)')
                            .setStyle(ButtonStyle.Success)
                        );
                        await wm.edit({ components: [row] }).catch(() => {});
                      }
                    }
                  }

                  if (!ws?.first_gif_sent_at && rc.welcomeChatChannelId) {
                    let gifUrl = null;
                    try {
                      const gifsPath = path.join(__dirname, '..', 'assets', 'welcome-gifs.txt');
                      const raw = require('fs').readFileSync(gifsPath, 'utf8');
                      const urls = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                      if (urls.length) gifUrl = urls[Math.floor(Math.random() * urls.length)];
                    } catch {}
                    if (!gifUrl) {
                      try {
                        const fallback = path.join(__dirname, '..', 'assets', 'welcome-default.gif');
                        if (require('fs').existsSync(fallback)) gifUrl = fallback;
                      } catch {}
                    }

                    const chat = await interaction.client.channels.fetch(rc.welcomeChatChannelId).catch(() => null);
                    if (chat && chat.isTextBased()) {
                      const embed = new EmbedBuilder()
                        .setColor(0x3498db)
                        .setTitle('🎉 Bienvenue !')
                        .setDescription(`Bienvenue à <@${targetUserId}> !`)
                        .setImage(typeof gifUrl === 'string' && gifUrl.startsWith('http') ? gifUrl : null);

                      const files = [];
                      if (gifUrl && typeof gifUrl === 'string' && !gifUrl.startsWith('http')) {
                        files.push({ attachment: gifUrl, name: 'welcome.gif' });
                        embed.setImage('attachment://welcome.gif');
                      }

                      await chat.send({ embeds: [embed], files, allowedMentions: { users: [targetUserId], parse: [] } }).catch(() => {});
                      db.prepare(
                        `INSERT INTO welcome_state (guild_id, user_id, first_gif_sent_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(guild_id, user_id) DO UPDATE SET first_gif_sent_at=excluded.first_gif_sent_at`
                      ).run(guildId, targetUserId, Date.now());
                    }
                  }
                } catch {}

                await interaction.message.edit({ components: [] }).catch(() => {});
                return interaction.reply({ content: `✅ Invité validé pour ${target}.`, ephemeral: true });
              }

              if (action === 'deny') {
                if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
                  return interaction.reply({ content: "Je n'ai pas la permission **Expulser des membres**.", ephemeral: true });
                }
                await target.kick('Refus staff (invité)');
                await interaction.message.edit({ components: [] }).catch(() => {});
                return interaction.reply({ content: `⚔️ ${targetUserId} expulsé du serveur.`, ephemeral: true });
              }

              return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
            }

            // mode = guildeux
            if (action === 'approve') {
              if (roleGTO) await target.roles.add(roleGTO).catch(() => {});
              if (roleDEF) await target.roles.add(roleDEF).catch(() => {});
              // Remove invite role if present
              if (roleInvite) await target.roles.remove(roleInvite).catch(() => {});

              await updateProfileBox(interaction.guild, rc, targetUserId, {
                statusText: `✅ Validé — ${roleGTO ? roleGTO.toString() : '@GTO'} ${roleDEF ? roleDEF.toString() : '@DEF'}`,
              });

              // Enable GIF button + auto-send first GIF (with @everyone) once validated
              try {
                const ws = db.prepare('SELECT welcome_message_id, joined_at, first_gif_sent_at FROM welcome_state WHERE guild_id=? AND user_id=?').get(guildId, targetUserId);
                if (ws?.welcome_message_id && rc.welcomeChannelId) {
                  const wch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
                  if (wch && wch.isTextBased()) {
                    const wm = await wch.messages.fetch(ws.welcome_message_id).catch(() => null);
                    if (wm) {
                      const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                          .setCustomId(`welgif:${guildId}:${targetUserId}:${Number(ws.joined_at || target.joinedTimestamp || Date.now())}`)
                          .setLabel('🎉 Souhaiter la bienvenue (GIF)')
                          .setStyle(ButtonStyle.Success)
                      );
                      await wm.edit({ components: [row] }).catch(() => {});
                    }
                  }
                }

                if (!ws?.first_gif_sent_at && rc.welcomeChatChannelId) {
                  let gifUrl = null;
                  try {
                    const gifsPath = path.join(__dirname, '..', 'assets', 'welcome-gifs.txt');
                    const raw = require('fs').readFileSync(gifsPath, 'utf8');
                    const urls = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
                    if (urls.length) gifUrl = urls[Math.floor(Math.random() * urls.length)];
                  } catch {}
                  if (!gifUrl) {
                    try {
                      const fallback = path.join(__dirname, '..', 'assets', 'welcome-default.gif');
                      if (require('fs').existsSync(fallback)) gifUrl = fallback;
                    } catch {}
                  }

                  const chat = await interaction.client.channels.fetch(rc.welcomeChatChannelId).catch(() => null);
                  if (chat && chat.isTextBased()) {
                    const embed = new EmbedBuilder()
                      .setColor(0x3498db)
                      .setTitle('🎉 Bienvenue !')
                      .setDescription(`Bienvenue à <@${targetUserId}> !`)
                      .setImage(typeof gifUrl === 'string' && gifUrl.startsWith('http') ? gifUrl : null);

                    const files = [];
                    if (gifUrl && typeof gifUrl === 'string' && !gifUrl.startsWith('http')) {
                      files.push({ attachment: gifUrl, name: 'welcome.gif' });
                      embed.setImage('attachment://welcome.gif');
                    }

                    await chat.send({ embeds: [embed], files, allowedMentions: { users: [targetUserId], parse: [] } }).catch(() => {});
                    db.prepare(
                      `INSERT INTO welcome_state (guild_id, user_id, first_gif_sent_at)
                       VALUES (?, ?, ?)
                       ON CONFLICT(guild_id, user_id) DO UPDATE SET first_gif_sent_at=excluded.first_gif_sent_at`
                    ).run(guildId, targetUserId, Date.now());
                  }
                }
              } catch {}

              await interaction.message.edit({ components: [] }).catch(() => {});
              return interaction.reply({ content: `✅ Validé. Rôles attribués à ${target}.`, ephemeral: true });
            }

            if (action === 'deny') {
              // Ensure invite role (and remove any guild roles)
              if (roleGTO) await target.roles.remove(roleGTO).catch(() => {});
              if (roleDEF) await target.roles.remove(roleDEF).catch(() => {});
              if (roleGuildeux) await target.roles.remove(roleGuildeux).catch(() => {});
              if (roleInvite) await target.roles.add(roleInvite).catch(() => {});

              await updateProfileBox(interaction.guild, rc, targetUserId, {
                statusText: `❌ Refusé — ${roleInvite ? roleInvite.toString() : 'Invité'}`,
              });

              await interaction.message.edit({ components: [] }).catch(() => {});
              return interaction.reply({ content: `❌ Refusé. ${target} est maintenant invité.`, ephemeral: true });
            }

            if (action === 'kick') {
              if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
                return interaction.reply({ content: "Je n'ai pas la permission **Expulser des membres**.", ephemeral: true });
              }
              await target.kick('Refus staff (demande guildeux)').catch(() => {});
              await interaction.message.edit({ components: [] }).catch(() => {});
              return interaction.reply({ content: `⚔️ ${targetUserId} expulsé du serveur.`, ephemeral: true });
            }

            return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
          } catch (e) {
            return interaction.reply({ content: `Erreur: ${e.message}`, ephemeral: true });
          }
        }

        // Welcome role buttons
        if (interaction.customId.startsWith('welgif:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const newUserId = parts[2];
          const joinedAt = Number(parts[3] || 0);

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          // New joiner should NOT use this button
          if (interaction.user.id === newUserId) {
            return interaction.reply({ content: 'Ce bouton est réservé aux membres pour te souhaiter la bienvenue 🙂', ephemeral: true });
          }

          // Expire after 2 hours
          const ageMs = joinedAt ? (Date.now() - joinedAt) : Infinity;
          if (ageMs > 2 * 60 * 60 * 1000) {
            // Best-effort: remove the button row if possible
            try { await interaction.message.edit({ components: [] }); } catch {}
            return interaction.reply({ content: '⌛ Ce bouton a expiré (2h après l’arrivée).', ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          if (!rc.welcomeChatChannelId) {
            return interaction.reply({ content: 'Salon chat-arrive non configuré.', ephemeral: true });
          }

          const ch = await interaction.client.channels.fetch(rc.welcomeChatChannelId).catch(() => null);
          if (!ch || !ch.isTextBased()) {
            return interaction.reply({ content: 'Salon chat-arrive inaccessible.', ephemeral: true });
          }

          // Cooldown per user (3s)
          const key = `welgif:${interaction.guild.id}:${interaction.user.id}`;
          const now = Date.now();
          const last = cooldown.get(key) || 0;
          if (now - last < 3_000) {
            return interaction.reply({ content: '⏳ Attends 3 secondes avant de renvoyer un GIF.', ephemeral: true });
          }
          cooldown.set(key, now);

          let gifUrl = null;
          try {
            const gifsPath = path.join(__dirname, '..', 'assets', 'welcome-gifs.txt');
            const raw = require('fs').readFileSync(gifsPath, 'utf8');
            const urls = raw
              .split(/\r?\n/)
              .map(l => l.trim())
              .filter(l => l && !l.startsWith('#'));
            if (urls.length) gifUrl = urls[Math.floor(Math.random() * urls.length)];
          } catch {}

          if (!gifUrl) {
            return interaction.reply({ content: 'Liste de GIFs manquante (welcome-gifs.txt).', ephemeral: true });
          }

          const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('🎉 Bienvenue !')
            .setDescription(`${interaction.user} souhaite la bienvenue à <@${newUserId}> !`)
            .setImage(gifUrl);

          await ch.send({ embeds: [embed], allowedMentions: { users: [newUserId] } }).catch(() => {});
          return interaction.reply({ content: '✅ GIF envoyé dans le salon chat-arrive.', ephemeral: true });
        }

        if (interaction.customId.startsWith('welrole:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];
          const kind = parts[3];
          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }

          if (interaction.user.id !== targetUserId) {
            return interaction.reply({ content: "Ces boutons sont réservés au nouveau membre.", ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member) return interaction.reply({ content: 'Impossible de te récupérer.', ephemeral: true });

          // Needs ManageRoles + correct role hierarchy
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.reply({ content: "Je n'ai pas la permission **Gérer les rôles**.", ephemeral: true });
          }

          const roleG = rc.welcomeRoleGuildeuxId ? interaction.guild.roles.cache.get(rc.welcomeRoleGuildeuxId) : null;
          const roleI = rc.welcomeRoleInviteId ? interaction.guild.roles.cache.get(rc.welcomeRoleInviteId) : null;

          try {
            if (kind === 'guildeux') {
              if (!roleG) return interaction.reply({ content: 'Rôle Guildeux non configuré.', ephemeral: true });

              // Ask for IGN via modal first; roles + staff alert will happen on modal submit.
              const modal = new ModalBuilder()
                .setCustomId(`ign:${interaction.guild.id}:${interaction.user.id}:${kind}:${interaction.message.id}`)
                .setTitle('Pseudo en jeu');

              const input = new TextInputBuilder()
                .setCustomId('ign')
                .setLabel('Tes pseudos en jeu (un par ligne)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(800)
                .setPlaceholder('Ex:\nTonyMerguez\nTonyMerguez-2\nMageTony');

              modal.addComponents(new ActionRowBuilder().addComponents(input));

              // Do NOT edit the welcome message here.
              // If the member closes the modal by mistake, they must be able to click again.
              // We will update the message components after the modal submit succeeds.
              return interaction.showModal(modal);
            }

            if (kind === 'invite') {
              if (!roleI) return interaction.reply({ content: 'Rôle Invité non configuré.', ephemeral: true });

              // Invités: NO IGN required.
              await member.roles.add(roleI).catch(() => {});
              if (roleG) await member.roles.remove(roleG).catch(() => {});
              await postStaffValidationAlert(interaction.guild, rc, targetUserId, 'Invité').catch(() => {});

              // After selection, remove the welcome message buttons.
              // The GIF button will be enabled ONLY after staff validation.
              try {
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`welwait:${guildId}:${targetUserId}`)
                    .setLabel('⏳ En attente de validation staff')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
                );
                await interaction.message.edit({ components: [row] }).catch(() => {});
              } catch {}

              return interaction.reply({ content: '✅ Statut Invité enregistré.', ephemeral: true });
            }

            return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
          } catch (e) {
            return interaction.reply({ content: `Erreur rôle: ${e.message}`, ephemeral: true });
          }
        }

        // Dashboard buttons
        if (interaction.customId.startsWith('dash:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const action = parts[2];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Dashboard invalide (mauvais serveur).', ephemeral: true });
          }

          const isOwner = interaction.guild.ownerId === interaction.user.id;
          if (!isOwner) {
            return interaction.reply({ content: 'Seul le propriétaire du serveur peut utiliser ce dashboard.', ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);

          if (action === 'ping') {
            return interaction.reply({
              content:
                `Utilise cette commande (avec les sélecteurs) :\n` +
                `**/setup_ping** panneau:<#...> alertes:<#...> def_role:<@&...> titre:"${rc.panelTitle || 'Ping DEF'}" cooldown:${rc.cooldownSeconds}`,
              ephemeral: true,
            });
          }
          if (action === 'score') {
            return interaction.reply({
              content:
                `Utilise cette commande :\n` +
                `**/setup_scoreboard** salon:<#...> role_guildeux:<@&...> top:${rc.scoreboardTopN || 25}`,
              ephemeral: true,
            });
          }
          if (action === 'welcome') {
            return interaction.reply({
              content:
                `Utilise :\n` +
                `**/setup_welcome** salon:<#...> guilde:"${rc.welcomeGuildName || 'GTO'}" ping_everyone:true role_guildeux:<@&...> role_invite:<@&...>`,
              ephemeral: true,
            });
          }
          if (action === 'rules') {
            return interaction.reply({ content: `Utilise :\n**/setup_reglement** salon:<#...> role_acces:<@&...>`, ephemeral: true });
          }
          if (action === 'admin') {
            return interaction.reply({ content: `Utilise :\n**/setup_admin** role:<@&...>`, ephemeral: true });
          }
          if (action === 'status') {
            return interaction.reply({ content: `Utilise :\n**/setup_status**`, ephemeral: true });
          }

          return interaction.reply({ content: 'Action dashboard inconnue.', ephemeral: true });
        }

        // Ping panel buttons
        const [kind, channelId, name] = interaction.customId.split(':');
        if (kind !== 'ping') return;

        // Cooldown per button
        const key = `${channelId}:${name}`;
        const last = cooldown.get(key) || 0;
        const rc = getConfigForGuild(interaction.guild.id);
        if (nowMs() - last < rc.cooldownSeconds * 1000) {
          const gifPath = path.join(__dirname, '..', 'assets', 'calme-toi-zebi.gif');
          return interaction.reply({
            content: `**LES TROUPES SONT DÉJÀ ALERTÉ !**`,
            ephemeral: true,
            files: [{ attachment: gifPath, name: 'calme.gif' }],
          });
        }
        cooldown.set(key, nowMs());

        const guild = interaction.guild;

        const btn = panel.resolveButton(interaction.guild.id, channelId, name);
        if (!btn) return interaction.reply({ content: 'Button not configured.', ephemeral: true });

        const p = panel.getPanel(interaction.guild.id, channelId);
        const alertChannelId = p?.alert_channel_id || rc.alertChannelId;
        const alertChannel = await interaction.client.channels.fetch(alertChannelId).catch(() => null);
        if (!alertChannel || !alertChannel.isTextBased()) {
          return interaction.reply({ content: `Alert channel not accessible (<#${alertChannelId}>).`, ephemeral: true });
        }

        // Always include DEF role in all pings
        const pingRoles = [rc.defRoleId, btn.role_id].filter(Boolean);

        // Mention control: allow only these roles
        const emojiPrefix = btn.emoji ? `<${String(btn.emoji).match(/^\d+$/) ? ':' : ''}>` : '';
        // If btn.emoji is an ID, format it as <:name:id> is not possible without name; use <a:_:id> or <:_:id>
        // We'll render custom emoji via <a:_:{id}> (Discord will resolve if animated) or <:_:id>.
        let emojiText = '';
        if (btn.emoji) {
          const s = String(btn.emoji);
          if (s.match(/^\d+$/)) {
            // Emoji id only: resolve in guild cache if possible (keeps animated/static).
            const found = interaction.guild.emojis.cache.get(s);
            emojiText = found ? found.toString() : `<:_:${s}>`;
          } else {
            // Unicode or raw custom emoji (<:name:id> or <a:name:id>)
            emojiText = s;
          }
        }

        const rolesText = pingRoles.map(id => `<@&${id}>`).join(' ');
        const prefix = btn.unicode_prefix ? `${btn.unicode_prefix} ` : '';
        const emojiPart = emojiText ? `${emojiText} ` : '';

        // Style 4 (RP / dramatique) — 3 lines
        const hiddenMentions = `||${rolesText}||`;
        const content = [
          `${prefix}${emojiPart}⚔️ **${btn.label} EST ATTAQUÉE !**`,
          `Rassemblement immédiat — défendez le blason !`,
          `Alerte envoyée par ${interaction.user} → ${hiddenMentions}`,
        ].join('\n');

        await alertChannel.send({
          content,
          allowedMentions: { roles: pingRoles },
        });

        // Scoreboard: count ALL alert button clicks (guilde, rush, everyone, etc.) as long as the alert was sent successfully.
        // (User choice: count only on success — this code runs after alertChannel.send)
        try {
          if (rc.scoreboardChannelId) {
            scoreboard.incrementPing(interaction.guild.id, interaction.user.id);
            const sbChannel = await interaction.client.channels.fetch(rc.scoreboardChannelId).catch(() => null);
            if (sbChannel && sbChannel.isTextBased()) {
              await scoreboard.ensureScoreboardMessage(interaction.guild, sbChannel, { topN: rc.scoreboardTopN });
            }
          }
        } catch (e) {
          console.warn('[bot] scoreboard update failed:', e?.message || e);
        }

        // No ephemeral ack on success (avoid noise). Only reply on errors/cooldown.
        return interaction.deferUpdate();
      }
    } catch (e) {
      try {
        if (interaction.isRepliable()) {
          await interaction.reply({ content: 'Erreur interne.', ephemeral: true });
        }
      } catch {}
      console.error('[bot] interaction error', e);
    }
  });

  await client.login(config.token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


