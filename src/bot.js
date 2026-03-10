const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const panel = require('./panel');

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

async function ensurePanelMessage(channel) {
  // Ensure panel record exists; keep any per-channel alert override if already set.
  const existing = panel.getPanel(config.guildId, channel.id);
  panel.upsertPanel(config.guildId, channel.id, {
    title: config.panelTitle,
    alertChannelId: existing?.alert_channel_id || config.alertChannelId,
  });
  const p = panel.getPanel(config.guildId, channel.id);
  const components = panel.buildComponents(config.guildId, channel.id);

  const title = p?.title || config.panelTitle;
  const header = `**${title}**`;
  const content = [
    header,
    "━━━━━━━━━━━━━━━━━━━━",
    "**À quoi ça sert ?**",
    "Clique sur un bouton pour envoyer une alerte dans le salon d’alerte (ping DEF + rôle de la guilde).",
    "",
    "**Règles**",
    "• Pas de spam : un bouton a un petit cooldown.",
    "• Si tu cliques par erreur : pas grave, on se calme et on repart.",
    "",
    "⚠️ **En cas d’attaque : clique → c’est tout.**",
  ].join("\n");

  if (p && p.message_id) {
    try {
      const msg = await channel.messages.fetch(p.message_id);
      await msg.edit({ content, components });
      return msg;
    } catch {
      // fallthrough: recreate
    }
  }

  const msg = await channel.send({ content, components });
  panel.setPanelMessageId(config.guildId, channel.id, msg.id);
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
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);

  // Important: if old global commands exist (previous versions), Discord clients may show
  // “commande obsolète” for a while. Clearing global commands avoids stale autocomplete.
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
  } catch (e) {
    console.warn('[bot] could not clear global commands:', e?.message || e);
  }

  await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
}

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once('ready', async () => {
    try {
      await registerCommands(client);

      const guild = await client.guilds.fetch(config.guildId);
      const channel = await client.channels.fetch(config.defaultChannelId);

      // Seed first button if not present
      panel.upsertGuildButton(config.guildId, config.defaultChannelId, {
        name: 'GTO',
        roleId: '1480657602382790902',
        label: 'GTO',
        sortOrder: 0,
      });

      await ensurePanelMessage(channel);
      console.log('[bot] ready');

      // Validate def role mentionability
      const me = client.user;
      const perm = canPingRole(guild, me, config.defRoleId);
      if (!perm.ok) console.warn('[bot] DEF role ping may fail:', perm.reason);
    } catch (e) {
      console.error('[bot] ready error', e);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        // Admin auth: guild owner OR one of the allowed roles (meneur/dev mode)
        const guild = interaction.guild;
        const isOwner = guild && interaction.user && guild.ownerId === interaction.user.id;
        const memberRoles = interaction.member?.roles;
        const hasAllowedRole = !!(memberRoles && config.adminRoleIds.some(rid => memberRoles.cache?.has(rid)));

        if (!isOwner && !hasAllowedRole) {
          return interaction.reply({ content: "Permissions insuffisantes (réservé à l'Owner, @meneur, @dev mode).", ephemeral: true });
        }

        // Command restriction: only allow admin commands in the panel channel
        if (interaction.channelId !== config.defaultChannelId) {
          return interaction.reply({ content: `Commande autorisée uniquement dans <#${config.defaultChannelId}>.`, ephemeral: true });
        }

        if (interaction.commandName === 'panneau_creer') {
          const channel = interaction.options.getChannel('canal', true);
          const alertChannel = interaction.options.getChannel('canal_alerte', true);
          const title = interaction.options.getString('titre') || config.panelTitle;
          const pin = interaction.options.getBoolean('epingle') || false;

          panel.upsertPanel(config.guildId, channel.id, { title, alertChannelId: alertChannel.id });
          const msg = await ensurePanelMessage(channel);
          if (pin) {
            try { await msg.pin(); } catch {}
          }
          return interaction.reply({ content: `Panneau prêt dans <#${channel.id}> (alertes dans <#${alertChannel.id}>) (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'panneau_actualiser') {
          const channel = interaction.options.getChannel('canal', true);
          const msg = await ensurePanelMessage(channel);
          return interaction.reply({ content: `Panneau actualisé dans <#${channel.id}> (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'guilde_ajouter') {
          const channelId = config.defaultChannelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          const role = interaction.options.getRole('role', true);
          const label = (interaction.options.getString('label') || name).slice(0, 80);
          let emoji = interaction.options.getString('emoji');
          const image = interaction.options.getAttachment('image');
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

          panel.upsertGuildButton(config.guildId, channelId, {
            name,
            roleId: role.id,
            label,
            emoji,
            unicodePrefix,
            sortOrder: order,
          });

          const panelChannel = await interaction.client.channels.fetch(channelId);
          await ensurePanelMessage(panelChannel);
          return interaction.reply({ content: `Guilde ${name} ajoutée/modifiée → <@&${role.id}>.`, ephemeral: true });
        }

        if (interaction.commandName === 'guilde_supprimer') {
          const channelId = config.defaultChannelId;
          const name = interaction.options.getString('nom', true).toUpperCase();
          panel.removeGuildButton(config.guildId, channelId, name);
          const panelChannel = await interaction.client.channels.fetch(channelId);
          await ensurePanelMessage(panelChannel);
          return interaction.reply({ content: `Guilde ${name} supprimée du panneau.`, ephemeral: true });
        }
      }

      if (interaction.isButton()) {
        const [kind, channelId, name] = interaction.customId.split(':');
        if (kind !== 'ping') return;

        // Cooldown per button
        const key = `${channelId}:${name}`;
        const last = cooldown.get(key) || 0;
        if (nowMs() - last < config.cooldownSeconds * 1000) {
          const gifPath = path.join(__dirname, '..', 'assets', 'calme-toi-zebi.gif');
          return interaction.reply({
            content: `**LES TROUPES SONT DÉJÀ ALERTÉ !**`,
            ephemeral: true,
            files: [{ attachment: gifPath, name: 'calme.gif' }],
          });
        }
        cooldown.set(key, nowMs());

        const guild = interaction.guild;
        const btn = panel.resolveButton(config.guildId, channelId, name);
        if (!btn) return interaction.reply({ content: 'Button not configured.', ephemeral: true });

        const p = panel.getPanel(config.guildId, channelId);
        const alertChannelId = p?.alert_channel_id || config.alertChannelId;
        const alertChannel = await interaction.client.channels.fetch(alertChannelId).catch(() => null);
        if (!alertChannel || !alertChannel.isTextBased()) {
          return interaction.reply({ content: `Alert channel not accessible (<#${alertChannelId}>).`, ephemeral: true });
        }

        // Always include DEF role in all pings
        const pingRoles = [config.defRoleId, btn.role_id];

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

        const prefix = btn.unicode_prefix ? `${btn.unicode_prefix} ` : '';
        const emojiPart = emojiText ? `${emojiText} ` : '';
        const content = `${prefix}${emojiPart}🔔 **${btn.label}** — alerte demandée par ${interaction.user} : ${pingRoles.map(id => `<@&${id}>`).join(' ')}`;

        await alertChannel.send({
          content,
          allowedMentions: { roles: pingRoles },
        });

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
