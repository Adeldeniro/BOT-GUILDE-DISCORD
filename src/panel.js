const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('./db');

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getButtons(guildId, channelId) {
  return db.prepare(
    `SELECT name, role_id, label, emoji
     FROM guild_buttons
     WHERE guild_id = ? AND channel_id = ?
     ORDER BY sort_order ASC, name ASC`
  ).all(guildId, channelId);
}

function buildComponents(guildId, channelId) {
  const buttons = getButtons(guildId, channelId);

  // Discord: max 5 buttons per row, 5 rows per message (25 buttons)
  const rows = chunk(buttons, 5).slice(0, 5).map(group => {
    const row = new ActionRowBuilder();
    for (const b of group) {
      const customId = `ping:${channelId}:${b.name}`;
      const btn = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(b.label)
        .setStyle(ButtonStyle.Secondary);
      if (b.emoji) btn.setEmoji(b.emoji);
      row.addComponents(btn);
    }
    return row;
  });

  return rows;
}

function upsertPanel(guildId, channelId, title) {
  db.prepare(
    `INSERT INTO panels (guild_id, channel_id, title)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id, channel_id)
     DO UPDATE SET title=excluded.title`
  ).run(guildId, channelId, title);
}

function setPanelMessageId(guildId, channelId, messageId) {
  db.prepare(
    `UPDATE panels SET message_id=? WHERE guild_id=? AND channel_id=?`
  ).run(messageId, guildId, channelId);
}

function getPanel(guildId, channelId) {
  return db.prepare(
    `SELECT guild_id, channel_id, message_id, title FROM panels WHERE guild_id=? AND channel_id=?`
  ).get(guildId, channelId);
}

function upsertGuildButton(guildId, channelId, { name, roleId, label, emoji, sortOrder = 0 }) {
  db.prepare(
    `INSERT INTO guild_buttons (guild_id, channel_id, name, role_id, label, emoji, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, channel_id, name)
     DO UPDATE SET role_id=excluded.role_id, label=excluded.label, emoji=excluded.emoji, sort_order=excluded.sort_order`
  ).run(guildId, channelId, name, roleId, label, emoji || null, sortOrder);
}

function removeGuildButton(guildId, channelId, name) {
  db.prepare(
    `DELETE FROM guild_buttons WHERE guild_id=? AND channel_id=? AND name=?`
  ).run(guildId, channelId, name);
}

function resolveButton(guildId, channelId, name) {
  return db.prepare(
    `SELECT name, role_id, label, emoji FROM guild_buttons WHERE guild_id=? AND channel_id=? AND name=?`
  ).get(guildId, channelId, name);
}

module.exports = {
  buildComponents,
  upsertPanel,
  getPanel,
  setPanelMessageId,
  upsertGuildButton,
  removeGuildButton,
  resolveButton,
};
