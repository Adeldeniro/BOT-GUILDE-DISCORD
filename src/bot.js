const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { getConfigForGuild } = require('./runtimeConfig');
const { updateGuildConfig } = require('./guildConfig');
const panel = require('./panel');
const scoreboard = require('./scoreboard');
const profiles = require('./profiles');

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

// Prevent double-running (two bot instances => double pings)
const fs = require('fs');
const lockPath = path.join(__dirname, '..', 'bot.lock');
try {
  if (fs.existsSync(lockPath)) {
    const oldPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (oldPid && oldPid !== process.pid) {
      // If old PID still alive, exit
      try { process.kill(oldPid, 0); console.error('[bot] Another instance is running, exiting.'); process.exit(1); } catch {}
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });
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
        '**⚔️ 1) Esprit GTO**',
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

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎮 Profil joueur')
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

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🛡️ Validation staff — nouveau membre')
    .setDescription(`Nouveau membre : <@${targetUserId}>\nChoix : **${choiceLabel}**\n\nAttribuer les rôles **GTO** + **DEF** si la personne est bien un membre.`)
    .setFooter({ text: 'Clique sur Valider ou Refuser.' });

  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:approve`).setLabel('✅ Valider (GTO+DEF)').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`staffval:${guild.id}:${targetUserId}:deny`).setLabel('❌ Refuser (Invité)').setStyle(ButtonStyle.Danger),
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

  // Embed = best “official announcement” look on Discord
  const embed = new EmbedBuilder()
    .setColor(0x3498db) // blue
    .setTitle(`📣 ANNONCE OFFICIELLE — ${title}`)
    .addFields(
      { name: 'Objectif', value: 'ALERTER LA GUILDE ATTAQUÉE.', inline: false },
      {
        name: 'Comment faire',
        value: 'Clique sur le bouton correspondant pour envoyer l’alerte (ping DEF + rôle de la guilde) dans le salon d’alerte.',
        inline: false,
      },
      { name: 'Règles', value: '• PAS DE SPAM inutile ! (cooldown actif)\n• Erreur de clic : on assume, on se calme, et on repart.', inline: false },
    )
    .setFooter({ text: '⚠️ EN CAS D’ATTAQUE\n⬇️ Clique sur un bouton ⬇️' });

  const content = '';

  if (p && p.message_id) {
    try {
      const msg = await channel.messages.fetch(p.message_id);
      await msg.edit({ content, embeds: [embed], components });
      return msg;
    } catch {
      // fallthrough: recreate
    }
  }

  const msg = await channel.send({ content, embeds: [embed], components });
  panel.setPanelMessageId(rc.guildId, channel.id, msg.id);
  // Always pin the panel message if possible
  try { await msg.pin(); } catch {}
  return msg;
}

function buildHelpEmbed() {
  // Keep this in one place so it stays up to date automatically.
  // (Update the lists when you add/remove commands.)
  const sections = [
    {
      title: '🧩 Installation / Setup (Owner only)',
      lines: [
        '`/setup_dashboard salon:#...` — poste le dashboard de config',
        '`/setup_admin role:@...` — définit le rôle admin autorisé (optionnel)',
        '`/setup_ping panneau:#... alertes:#... def_role:@... (titre) (cooldown)`',
        '`/setup_scoreboard salon:#... role_guildeux:@... (top)`',
        '`/setup_profiles salon:#...` — salon identification (profils IGN)',
        '`/setup_reglement salon:#... role_acces:@...` — règlement + accès',
        '`/setup_validation_staff salon:#... staff1:@... (staff2) role_gto:@... role_def:@...`',
        '`/setup_welcome salon:#... guilde:"GTO" ping_everyone:true role_guildeux:@... role_invite:@...`',
        '`/setup_status` — affiche la config actuelle',
      ],
    },
    {
      title: '📌 Panneau & Guilde (Admin)',
      lines: [
        '`/panneau_creer canal:#... canal_alerte:#... (titre) (epingle)`',
        '`/panneau_actualiser canal:#...`',
        '`/guilde_ajouter nom:... role:@... (label) (emoji) (prefixe) (ordre)`',
        '`/guilde_supprimer nom:...`',
      ],
    },
    {
      title: '🛠️ Outils (Admin)',
      lines: [
        '`/clean (nombre)` — supprime des messages dans le salon actuel',
        '`/lock_write salon:#... role_autorise1:@... (role_autorise2) (role_autorise3) (unlock)`',
        '`/role_id role:@...` — affiche l’ID d’un rôle',
      ],
    },
    {
      title: '🎮 Profils (Staff)',
      lines: [
        '`/profile_set membre:@... pseudos:"un par ligne"` — modifie un profil',
        '`/profile_reset membre:@...` — supprime un profil',
        'Bouton **✏️ Modifier** sur la box profil (Meneur/BD uniquement)',
      ],
    },
  ];

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📘 Commandes du bot GTO — Guide staff')
    .setDescription('Résumé clair des commandes disponibles. (Message auto mis à jour lors des évolutions.)');

  for (const s of sections) {
    embed.addFields({ name: s.title, value: s.lines.join('\n').slice(0, 1024), inline: false });
  }

  embed.setFooter({ text: 'Astuce: utilisez le Dashboard setup pour installer rapidement sur un nouveau serveur.' });
  return embed;
}

async function ensureHelpMessage(guild, rc) {
  if (!rc.helpChannelId) return;
  const ch = await guild.client.channels.fetch(rc.helpChannelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const embed = buildHelpEmbed();

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
  await ch.send({ embeds: [embed] });
}

async function registerCommands(client) {
  const commands = [
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
      .addAttachmentOption(o => o.setName('image').setDescription('Blason (image upload) → sera converti en emoji').setRequired(false))
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
      .setName('setup_status')
      .setDescription('Afficher la config actuelle (owner only)'),

    new SlashCommandBuilder()
      .setName('setup_dashboard')
      .setDescription('Créer/mettre à jour le dashboard de configuration (owner only)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon où poster le dashboard').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setup_welcome')
      .setDescription('Configurer le message de bienvenue (owner only)')
      // Important: restrict to text channels to avoid “identifiant de salon invalide” on mobile
      .addChannelOption(o => o
        .setName('salon')
        .setDescription("Salon d'arrivée / bienvenue")
        .addChannelTypes(0, 5) // 0=GuildText, 5=GuildAnnouncement
        .setRequired(true))
      .addStringOption(o => o.setName('guilde').setDescription('Nom de la guilde (ex: GTO)').setRequired(false))
      .addBooleanOption(o => o.setName('ping_everyone').setDescription('Mentionner @everyone sur chaque arrivée').setRequired(false))
      .addRoleOption(o => o.setName('role_guildeux').setDescription('Rôle donné aux membres de la guilde').setRequired(false))
      .addRoleOption(o => o.setName('role_invite').setDescription('Rôle donné aux invités').setRequired(false)),

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
      .setName('clean')
      .setDescription('Nettoyer les messages dans ce salon (admin)')
      .addIntegerOption(o => o.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setRequired(false)),

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
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);

  // Important: if old global commands exist (previous versions), Discord clients may show
  // “commande obsolète” for a while.
  // NOTE: do NOT clear global commands on every startup (can cause missing commands / long propagation).
  // If you need a reset, do it manually once.


  // Always register guild commands when possible (fast propagation)
  if (!config.guildId) throw new Error('GUILD_ID is required for fast slash command propagation');
  await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
}

async function main() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites,
    ],
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
                await scoreboard.maybeWeeklyAnnouncement(guild, scoreboardChannel, { topN: 10 });
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

        const embed = new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('✅ Arrivée sur le serveur')
          .addFields(
            { name: 'Membre', value: `${member} (\`${member.id}\`)`, inline: false },
            { name: 'Compte', value: member.user.tag || member.user.username, inline: true },
            { name: 'Créé le', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            {
              name: 'Invité par',
              value: used?.inviter ? `${used.inviter} (code: \`${used.code}\`, uses: **${used.uses}**)` : 'Inconnu (permissions/intent invites manquants)',
              inline: false,
            },
          )
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

  client.on('guildMemberRemove', async (member) => {
    // Surveillance + cleanup profiles when someone leaves / is kicked
    try {
      const rc = getConfigForGuild(member.guild.id);

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
        .setTitle(kickedBy ? '⛔ Membre expulsé' : '🚪 Membre parti')
        .addFields(
          { name: 'Membre', value: `<@${member.id}> (\`${member.id}\`)`, inline: false },
          { name: 'Action', value: kickedBy ? `Kick par ${kickedBy}` : 'Départ volontaire', inline: false },
        )
        .setTimestamp();
      await sendSurveillance(member.guild, rc, embed);

      // Cleanup profile + delete profile box
      const existing = profiles.deleteProfile(member.guild.id, member.user.id);
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
      // Modal: collect in-game name (IGN)
      if (interaction.isModalSubmit && interaction.isModalSubmit()) {
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
            statusText: '✏️ Mis à jour par le staff',
          }).catch(() => {});

          // keep edit button
          try {
            const ch = await interaction.client.channels.fetch(rc.profilesChannelId).catch(() => null);
            if (ch && ch.isTextBased()) {
              const m = await ch.messages.fetch(msgId).catch(() => null);
              if (m) {
                const row = new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(`profedit:${guildId}:${targetUserId}`).setLabel('✏️ Modifier').setStyle(ButtonStyle.Secondary)
                );
                await m.edit({ components: [row] }).catch(() => {});
              }
            }
          } catch {}

          return interaction.reply({ content: '✅ Profil mis à jour.', ephemeral: true });
        }

        if (interaction.customId.startsWith('ign:')) { 
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const userId = parts[2];
          const choice = parts[3];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }
          if (interaction.user.id !== userId) {
            return interaction.reply({ content: 'Ce formulaire ne te concerne pas.', ephemeral: true });
          }

          const rc = getConfigForGuild(guildId);
          const ignRaw = (interaction.fields.getTextInputValue('ign') || '').trim();
          if (!ignRaw || ignRaw.length < 2) {
            return interaction.reply({ content: 'Pseudo en jeu invalide.', ephemeral: true });
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
                  .setLabel('✏️ Modifier')
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
            if (choice === 'guildeux' && roleG) {
              await member.roles.add(roleG).catch(() => {});
              if (roleI) await member.roles.remove(roleI).catch(() => {});
              await postStaffValidationAlert(interaction.guild, rc, userId, 'Guildeux');
            }
            if (choice === 'invite' && roleI) {
              await member.roles.add(roleI).catch(() => {});
              if (roleG) await member.roles.remove(roleG).catch(() => {});
              await postStaffValidationAlert(interaction.guild, rc, userId, 'Invité');
            }
          }

          // Remove welcome buttons message if we still have it
          const msgId = parts[4];
          if (msgId) {
            try {
              const wch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
              if (wch && wch.isTextBased()) {
                const m = await wch.messages.fetch(msgId).catch(() => null);
                if (m) await m.edit({ components: [] }).catch(() => {});
              }
            } catch {}
          }

          return interaction.reply({ content: '✅ Pseudo enregistré, merci !', ephemeral: true });
        }
      }

      if (interaction.isChatInputCommand()) {
        // Admin auth: guild owner OR one of the allowed roles (meneur/dev mode)
        const guild = interaction.guild;
        const isOwner = guild && interaction.user && guild.ownerId === interaction.user.id;
        const memberRoles = interaction.member?.roles;

        const rc = getConfigForGuild(guild.id);
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
            if (!salon.isTextBased?.()) {
              return interaction.reply({ content: 'Choisis un **salon texte** (pas une catégorie / vocal / thread).', ephemeral: true });
            }
            const guildeName = interaction.options.getString('guilde') || 'GTO';
            const pingEveryone = interaction.options.getBoolean('ping_everyone');
            const roleGuildeux = interaction.options.getRole('role_guildeux');
            const roleInvite = interaction.options.getRole('role_invite');

            updateGuildConfig(guild.id, {
              welcome_channel_id: salon.id,
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
          await updateProfileBox(interaction.guild, rc, user.id, { statusText: '✏️ Mis à jour par le staff' }).catch(() => {});
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

        if (interaction.commandName === 'guilde_ajouter') {
          const rc = getConfigForGuild(interaction.guild.id);
          const channelId = rc.panelChannelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          const role = interaction.options.getRole('role', true);
          const label = (interaction.options.getString('label') || name).slice(0, 80);
          let emoji = interaction.options.getString('emoji');
          const image = interaction.options.getAttachment('image');

          // Allow explicit “no emoji” sentinel values (useful if a Discord client caches the option as required)
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
          const channelId = rc.panelChannelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          panel.removeGuildButton(interaction.guild.id, channelId, name);
          const panelChannel = await interaction.client.channels.fetch(channelId);
          await ensurePanelMessage(panelChannel, rc);
          return interaction.reply({ content: `Guilde ${name} supprimée du panneau.`, ephemeral: true });
        }

      }

      if (interaction.isButton()) {
        // Rules acceptance button
        if (interaction.customId.startsWith('rulesok:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];

          if (!interaction.guild || interaction.guild.id !== guildId) {
            return interaction.reply({ content: 'Action invalide.', ephemeral: true });
          }
          if (interaction.user.id !== targetUserId) {
            return interaction.reply({ content: "Ce bouton est réservé au nouveau membre.", ephemeral: true });
          }

          const rc = getConfigForGuild(interaction.guild.id);
          if (!rc.rulesAccessRoleId) {
            return interaction.reply({ content: "Règlement non configuré (role_acces manquant).", ephemeral: true });
          }

          // Add access role
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            return interaction.reply({ content: "Je n'ai pas la permission **Gérer les rôles**.", ephemeral: true });
          }

          const accessRole = interaction.guild.roles.cache.get(rc.rulesAccessRoleId);
          if (!accessRole) return interaction.reply({ content: "Rôle d'accès introuvable.", ephemeral: true });

          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (!member) return interaction.reply({ content: 'Impossible de te récupérer.', ephemeral: true });

          try {
            await member.roles.add(accessRole);
          } catch (e) {
            return interaction.reply({ content: `Erreur rôle: ${e.message}`, ephemeral: true });
          }

          // Send welcome message now (arrival step)
          if (!rc.welcomeChannelId) {
            return interaction.reply({ content: `✅ Règlement validé. (Salon arrivée non configuré)`, ephemeral: true });
          }

          const ch = await interaction.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
          if (!ch || !ch.isTextBased()) {
            return interaction.reply({ content: `✅ Règlement validé. (Salon arrivée inaccessible)`, ephemeral: true });
          }

          // Build welcome message
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

          const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setAuthor({ name: `Nouvel arrivant`, iconURL: member.user.displayAvatarURL?.({ size: 128 }) })
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
          if (gifUrl) {
            try {
              const resp = await fetch(gifUrl);
              if (resp.ok) {
                const buf = Buffer.from(await resp.arrayBuffer());
                files.push({ attachment: buf, name: 'welcome.gif' });
                embed.setImage('attachment://welcome.gif');
              }
            } catch {}
          }

          const content = rc.welcomePingEveryone ? '@everyone' : '';
          await ch.send({
            content,
            embeds: [embed],
            components,
            files,
            allowedMentions: rc.welcomePingEveryone ? { parse: ['everyone'] } : { parse: [] },
          });

          // Remove the prompt message entirely after success (less visible to others)
          try { await interaction.message.delete(); } catch {}

          // Ack
          try {
            await interaction.reply({ content: `✅ Règlement validé. Accès débloqué via ${accessRole}.`, ephemeral: true });
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

        // Staff validation buttons
        if (interaction.customId.startsWith('staffval:')) {
          const parts = interaction.customId.split(':');
          const guildId = parts[1];
          const targetUserId = parts[2];
          const action = parts[3];

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
            if (action === 'approve') {
              if (roleGTO) await target.roles.add(roleGTO);
              if (roleDEF) await target.roles.add(roleDEF);

              await updateProfileBox(interaction.guild, rc, targetUserId, {
                statusText: `✅ Validé — ${roleGTO ? roleGTO.toString() : '@GTO'} ${roleDEF ? roleDEF.toString() : '@DEF'}`,
              });

              await interaction.message.edit({ components: [] }).catch(() => {});
              return interaction.reply({ content: `✅ Validé. Rôles attribués à ${target}.`, ephemeral: true });
            }

            if (action === 'deny') {
              if (roleGuildeux) await target.roles.remove(roleGuildeux).catch(() => {});
              if (roleInvite) await target.roles.add(roleInvite).catch(() => {});

              await updateProfileBox(interaction.guild, rc, targetUserId, {
                statusText: `❌ Refusé — ${roleInvite ? roleInvite.toString() : 'Invité'}`,
              });

              await interaction.message.edit({ components: [] }).catch(() => {});
              return interaction.reply({ content: `❌ Refusé. ${target} est maintenant invité.`, ephemeral: true });
            }

            return interaction.reply({ content: 'Action inconnue.', ephemeral: true });
          } catch (e) {
            return interaction.reply({ content: `Erreur: ${e.message}`, ephemeral: true });
          }
        }

        // Welcome role buttons
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
            if ((kind === 'guildeux' && roleG) || (kind === 'invite' && roleI)) {
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
              return interaction.showModal(modal);
            }
            return interaction.reply({ content: 'Rôle non configuré.', ephemeral: true });
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

        // Scoreboard: count pings for members who have the @guildeux role
        try {
          const member = interaction.member;
          if (rc.guildeuxRoleId && rc.scoreboardChannelId) {
            const hasGuildeux = !!(member?.roles && member.roles.cache?.has(rc.guildeuxRoleId));
            if (hasGuildeux) {
              scoreboard.incrementPing(interaction.guild.id, interaction.user.id);
              const sbChannel = await interaction.client.channels.fetch(rc.scoreboardChannelId).catch(() => null);
              if (sbChannel && sbChannel.isTextBased()) {
                await scoreboard.ensureScoreboardMessage(interaction.guild, sbChannel, { topN: rc.scoreboardTopN });
              }
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
