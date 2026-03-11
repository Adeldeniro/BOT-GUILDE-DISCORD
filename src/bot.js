const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { getConfigForGuild } = require('./runtimeConfig');
const { updateGuildConfig } = require('./guildConfig');
const panel = require('./panel');
const scoreboard = require('./scoreboard');

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
        value: `🛡️ Ping/Alertes: ${okPing ? '✅' : '❌'}\n📊 Scoreboard: ${okScore ? '✅' : '❌'}\n👋 Bienvenue: ${okWelcome ? '✅' : '❌'}\n👤 Admin role: ${rc.adminRoleId ? `<@&${rc.adminRoleId}>` : '—'}`,
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
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);

  // Important: if old global commands exist (previous versions), Discord clients may show
  // “commande obsolète” for a while. Clearing global commands avoids stale autocomplete.
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  } catch (e) {
    console.warn('[bot] could not clear global commands:', e?.message || e);
  }

  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
  } else {
    // If no default guild is set, register global commands (slower to propagate)
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  }
}

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
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
    } catch (e) {
      console.error('[bot] ready error', e);
    }
  });

  client.on('guildMemberAdd', async (member) => {
    try {
      const rc = getConfigForGuild(member.guild.id);
      if (!rc.welcomeChannelId) return;

      const ch = await member.client.channels.fetch(rc.welcomeChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) return;

      // Pick a random GIF URL from assets/welcome-gifs.txt
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
        .setTitle('👋 Bienvenue parmi nous !')
        .setDescription(
          `✨ ${member} rejoint la guilde **${rc.welcomeGuildName || 'GTO'}** !\n\n` +
          `Ici c’est **fraternité**, **entraide** et **bonne ambiance**.\n` +
          `Passe dire bonjour et installe-toi tranquillement.`
        )
        .setFooter({ text: 'On est contents de te compter parmi nous.' });

      // Role buttons (optional)
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

      const content = rc.welcomePingEveryone ? '@everyone' : '';

      // Make GIFs reliable: download and attach, then point embed image to attachment://
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

      await ch.send({
        content,
        embeds: [embed],
        components,
        files,
        allowedMentions: rc.welcomePingEveryone ? { parse: ['everyone'] } : { parse: [] },
      });
    } catch (e) {
      console.warn('[bot] welcome error:', e?.message || e);
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

            return interaction.reply({ content: `OK. Bienvenue configurée dans <#${salon.id}> (guilde: ${guildeName}) (ping everyone: ${pingEveryone ? 'ON' : 'OFF'}) (roles: ${roleGuildeux ? roleGuildeux.toString() : '—'} / ${roleInvite ? roleInvite.toString() : '—'}).`, ephemeral: true });
          }

          return interaction.reply({ content: 'Commande setup inconnue.', ephemeral: true });
        } else {
          // Command restriction: only allow admin commands in the panel channel
          if (rc.panelChannelId && interaction.channelId !== rc.panelChannelId) {
            return interaction.reply({ content: `Commande autorisée uniquement dans <#${rc.panelChannelId}>.`, ephemeral: true });
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
            if (kind === 'guildeux' && roleG) {
              await member.roles.add(roleG);
              if (roleI) await member.roles.remove(roleI).catch(() => {});
              // Remove buttons from the original welcome message after successful choice
              try { await interaction.message.edit({ components: [] }); } catch {}
              return interaction.reply({ content: `✅ Rôle ajouté : ${roleG}`, ephemeral: true });
            }
            if (kind === 'invite' && roleI) {
              await member.roles.add(roleI);
              if (roleG) await member.roles.remove(roleG).catch(() => {});
              try { await interaction.message.edit({ components: [] }); } catch {}
              return interaction.reply({ content: `✅ Rôle ajouté : ${roleI}`, ephemeral: true });
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
