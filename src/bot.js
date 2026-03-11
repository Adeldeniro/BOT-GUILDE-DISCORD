const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { getConfigForGuild } = require('./runtimeConfig');
const { updateGuildConfig } = require('./guildConfig');
const panel = require('./panel');
const scoreboard = require('./scoreboard');

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
            ];
            return interaction.reply({ content: '```\n' + lines.join('\n') + '\n```', ephemeral: true });
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
