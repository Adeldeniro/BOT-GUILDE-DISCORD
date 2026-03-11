const { EmbedBuilder } = require('discord.js');
const db = require('./db');

function upsertScoreUser(guildId, userId) {
  db.prepare(
    `INSERT INTO guildeux_scores (guild_id, user_id, ping_count, last_ping_at)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(guild_id, user_id) DO NOTHING`
  ).run(guildId, userId);
}

function incrementPing(guildId, userId) {
  upsertScoreUser(guildId, userId);
  db.prepare(
    `UPDATE guildeux_scores
     SET ping_count = ping_count + 1,
         last_ping_at = ?
     WHERE guild_id = ? AND user_id = ?`
  ).run(Date.now(), guildId, userId);
}

function setScoreboardMessage(guildId, channelId, messageId) {
  db.prepare(
    `INSERT INTO scoreboard_state (guild_id, channel_id, message_id)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, message_id=excluded.message_id`
  ).run(guildId, channelId, messageId);
}

function getScoreboardState(guildId) {
  return db.prepare(
    `SELECT guild_id, channel_id, message_id, last_weekly_announce_date FROM scoreboard_state WHERE guild_id=?`
  ).get(guildId);
}

function setLastWeeklyAnnounceDate(guildId, ymd) {
  db.prepare(
    `INSERT INTO scoreboard_state (guild_id, last_weekly_announce_date)
     VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET last_weekly_announce_date=excluded.last_weekly_announce_date`
  ).run(guildId, ymd);
}

function listScores(guildId) {
  return db.prepare(
    `SELECT user_id, ping_count, last_ping_at FROM guildeux_scores WHERE guild_id=? ORDER BY ping_count DESC, last_ping_at DESC NULLS LAST`
  ).all(guildId);
}

function fmtYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function ensureScoreboardMessage(guild, channel, { topN = 25 } = {}) {
  const guildId = guild.id;
  const state = getScoreboardState(guildId);

  const embed = await buildScoreboardEmbed(guild, { topN });

  if (state?.message_id && state?.channel_id === channel.id) {
    try {
      const msg = await channel.messages.fetch(state.message_id);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {
      // recreate below
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  setScoreboardMessage(guildId, channel.id, msg.id);
  return msg;
}

async function buildScoreboardEmbed(guild, { topN = 25 } = {}) {
  const guildId = guild.id;

  // Fetch members to include everyone with the role, even if 0 pings.
  // Requires GuildMembers intent.
  await guild.members.fetch();

  const role = guild.roles.cache.get(require('./config').guildeuxRoleId);
  const guildeuxMembers = role ? role.members.map(m => m) : [];

  // Ensure DB rows exist
  for (const m of guildeuxMembers) upsertScoreUser(guildId, m.user.id);

  const scores = listScores(guildId);
  const scoreMap = new Map(scores.map(r => [r.user_id, r]));

  // Sort only guildeux members
  const entries = guildeuxMembers
    .map(m => {
      const s = scoreMap.get(m.user.id) || { ping_count: 0, last_ping_at: null };
      return { user: m.user, count: s.ping_count || 0, last: s.last_ping_at || 0 };
    })
    .sort((a, b) => (b.count - a.count) || (b.last - a.last) || (a.user.id.localeCompare(b.user.id)));

  const top = entries.slice(0, topN);

  const lines = top.map((e, i) => {
    const rank = String(i + 1).padStart(2, '0');
    return `**${rank}.** <@${e.user.id}> — **${e.count}** ping${e.count === 1 ? '' : 's'}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Classement des pings — Guildeux')
    .setDescription(lines.length ? lines.join('\n') : 'Aucun guildeux trouvé.')
    .setFooter({ text: 'Mise à jour automatique après chaque ping.' });

  return embed;
}

async function maybeWeeklyAnnouncement(guild, channel, { topN = 10 } = {}) {
  const now = new Date();
  const ymd = fmtYmd(now);

  // Sunday 19:00 local time
  const isSunday = now.getDay() === 0;
  const is19 = now.getHours() === 19;
  const isMinuteWindow = now.getMinutes() === 0; // run when minute == 0

  if (!isSunday || !is19 || !isMinuteWindow) return;

  const state = getScoreboardState(guild.id);
  if (state?.last_weekly_announce_date === ymd) return;

  const embed = await buildScoreboardEmbed(guild, { topN });
  embed.setTitle('🏆 Classement hebdo — Guildeux (pings)');
  embed.setFooter({ text: 'Annonce automatique du dimanche 19h.' });

  await channel.send({ embeds: [embed] });
  setLastWeeklyAnnounceDate(guild.id, ymd);
}

module.exports = {
  ensureScoreboardMessage,
  buildScoreboardEmbed,
  incrementPing,
  upsertScoreUser,
  maybeWeeklyAnnouncement,
};
