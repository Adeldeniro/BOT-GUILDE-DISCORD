const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
const path = require('path');
const config = require('./config');
const panel = require('./panel');

const cooldown = new Map(); // key: buttonKey -> lastTs

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

  const header = `**${p?.title || config.panelTitle}**`;
  const desc = `CLIQUE SUR LE BOUTON CI-DESSOUS POUR AVERTIR LA GUILDE QU'ELLE SE FAIT TABASSER ⚠️🚨🐴`;
  const content = `${header}\n${desc}`;

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
      .setName('panel_create')
      .setDescription('Create or update the ping panel in a channel')
      .addChannelOption(o => o.setName('channel').setDescription('Panel channel (buttons)').setRequired(true))
      .addChannelOption(o => o.setName('alert_channel').setDescription('Alert channel (pings)').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(false))
      .addBooleanOption(o => o.setName('pin').setDescription('Pin the panel message').setRequired(false)),

    new SlashCommandBuilder()
      .setName('panel_refresh')
      .setDescription('Refresh the panel buttons in a channel')
      .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('guild_add')
      .setDescription('Add/update a guild button')
      .addChannelOption(o => o.setName('channel').setDescription('Channel containing the panel').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Internal name (e.g. GTO)').setRequired(true))
      .addRoleOption(o => o.setName('role').setDescription('Role to ping for this guild').setRequired(true))
      .addStringOption(o => o.setName('label').setDescription('Button label').setRequired(false))
      .addStringOption(o => o.setName('emoji').setDescription('Emoji (optional)').setRequired(false))
      .addIntegerOption(o => o.setName('order').setDescription('Sort order (optional)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('guild_remove')
      .setDescription('Remove a guild button')
      .addChannelOption(o => o.setName('channel').setDescription('Channel containing the panel').setRequired(true))
      .addStringOption(o => o.setName('name').setDescription('Internal name to remove').setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, config.guildId),
    { body: commands }
  );
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
        const isAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageRoles);
        if (!isAdmin) {
          return interaction.reply({ content: 'Permission required (Manage Server or Manage Roles).', ephemeral: true });
        }

        if (interaction.commandName === 'panel_create') {
          const channel = interaction.options.getChannel('channel', true);
          const alertChannel = interaction.options.getChannel('alert_channel', true);
          const title = interaction.options.getString('title') || config.panelTitle;
          const pin = interaction.options.getBoolean('pin') || false;

          panel.upsertPanel(config.guildId, channel.id, { title, alertChannelId: alertChannel.id });
          const msg = await ensurePanelMessage(channel);
          if (pin) {
            try { await msg.pin(); } catch {}
          }
          return interaction.reply({ content: `Panel ready in <#${channel.id}> (alerts in <#${alertChannel.id}>) (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'panel_refresh') {
          const channel = interaction.options.getChannel('channel', true);
          const msg = await ensurePanelMessage(channel);
          return interaction.reply({ content: `Panel refreshed in <#${channel.id}> (message ${msg.id}).`, ephemeral: true });
        }

        if (interaction.commandName === 'guild_add') {
          const channel = interaction.options.getChannel('channel', true);
          const name = interaction.options.getString('name', true).toUpperCase();
          const role = interaction.options.getRole('role', true);
          const label = (interaction.options.getString('label') || name).slice(0, 80);
          const emoji = interaction.options.getString('emoji');
          const order = interaction.options.getInteger('order') || 0;

          panel.upsertGuildButton(config.guildId, channel.id, {
            name,
            roleId: role.id,
            label,
            emoji,
            sortOrder: order,
          });

          await ensurePanelMessage(channel);
          return interaction.reply({ content: `Added/updated guild ${name} -> <@&${role.id}> in <#${channel.id}>.`, ephemeral: true });
        }

        if (interaction.commandName === 'guild_remove') {
          const channel = interaction.options.getChannel('channel', true);
          const name = interaction.options.getString('name', true).toUpperCase();
          panel.removeGuildButton(config.guildId, channel.id, name);
          await ensurePanelMessage(channel);
          return interaction.reply({ content: `Removed guild ${name} from <#${channel.id}>.`, ephemeral: true });
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
        const content = `🔔 Ping **${btn.label}** demandé par ${interaction.user} : ${pingRoles.map(id => `<@&${id}>`).join(' ')}`;

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
