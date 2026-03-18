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

async function ensureScoreboardMessage(guild, channel, { topN = 25, forceNew = false, mode = 'current' } = {}) {
  const guildId = guild.id;
  const state = getScoreboardState(guildId);

  const embed = await buildScoreboardEmbed(guild, { topN, mode });

  if (!forceNew && state?.message_id && state?.channel_id === channel.id) {
    try {
      const msg = await channel.messages.fetch(state.message_id);
      await msg.edit({ embeds: [embed] });
      return msg;
    } catch {
      // recreate below
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  // No pin by default (user preference)
  setScoreboardMessage(guildId, channel.id, msg.id);
  return msg;
}

async function buildScoreboardEmbed(guild, { topN = 25, skipMemberFetch = false, mode = 'current' } = {}) {
  const guildId = guild.id;

  // Try to fetch members to include everyone with the role, even if 0 pings.
  // This can be slow on large guilds; allow skipping for manual/weekly announcements.
  if (!skipMemberFetch) {
    try {
      await guild.members.fetch();
    } catch {
      // ignore
    }
  }

  const { getConfigForGuild } = require('./runtimeConfig');
  const rc = getConfigForGuild(guild.id);
  if (!rc.guildeuxRoleId) {
    return new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('📊 Classement des pings — Guildeux')
      .setDescription('Scoreboard non configuré (rôle guildeux manquant). Relance **/setup_scoreboard** et sélectionne `role_guildeux`.');
  }

  const role = guild.roles.cache.get(rc.guildeuxRoleId);
  const guildeuxMembers = role ? role.members.map(m => m) : [];

  // Ensure DB rows exist for known guildeux members
  for (const m of guildeuxMembers) upsertScoreUser(guildId, m.user.id);

  const scores = listScores(guildId);

  let entries;
  if (guildeuxMembers.length) {
    const scoreMap = new Map(scores.map(r => [r.user_id, r]));
    // Sort only guildeux members
    entries = guildeuxMembers
      .map(m => {
        const s = scoreMap.get(m.user.id) || { ping_count: 0, last_ping_at: null };
        return { userId: m.user.id, count: s.ping_count || 0, last: s.last_ping_at || 0 };
      })
      .sort((a, b) => (b.count - a.count) || (b.last - a.last) || (a.userId.localeCompare(b.userId)));
  } else {
    // Fallback: show DB scores even if we can't see role members (missing intent/permissions/cache)
    entries = scores
      .map(s => ({ userId: s.user_id, count: s.ping_count || 0, last: s.last_ping_at || 0 }))
      .sort((a, b) => (b.count - a.count) || (b.last - a.last) || (a.userId.localeCompare(b.userId)));
  }

  const top = entries.slice(0, topN);
  const lines = top.map((e, i) => {
    const rank = String(i + 1).padStart(2, '0');
    return `**${rank}.** <@${e.userId}> — **${e.count}** ping${e.count === 1 ? '' : 's'}`;
  });

  const note = guildeuxMembers.length
    ? ''
    : "\n\n*(Note: impossible de lister les membres @guildeux côté bot — vérifie l'intent 'Server Members' et les permissions.)*";

  const isArchived = mode === 'archived';

  return new EmbedBuilder()
    .setColor(isArchived ? 0xe74c3c : 0x2ecc71)
    .setTitle(isArchived ? '🔴 Scoreboard — Semaine terminée' : '🟢 Scoreboard — Semaine en cours')
    .setDescription((lines.length ? lines.join('\n') : 'Aucun score enregistré.') + note)
    .setFooter({ text: isArchived ? 'Archivé (semaine précédente).' : 'Semaine en cours — mise à jour automatique.' });
}

function resetScores(guildId) {
  db.prepare(`UPDATE guildeux_scores SET ping_count=0, last_ping_at=NULL WHERE guild_id=?`).run(guildId);
}

async function rotateWeeklyBoard(guild, channel, { boardTopN = 25 } = {}) {
  const state = getScoreboardState(guild.id);

  // Archive current board (red)
  if (state?.message_id && state?.channel_id === channel.id) {
    try {
      const msg = await channel.messages.fetch(state.message_id).catch(() => null);
      if (msg) {
        const archived = await buildScoreboardEmbed(guild, { topN: boardTopN, skipMemberFetch: true, mode: 'archived' });
        await msg.edit({ embeds: [archived] }).catch(() => {});
      }
    } catch {}
  }

  // Reset
  resetScores(guild.id);

  // Post new current board (green) just after winners message
  await ensureScoreboardMessage(guild, channel, { topN: boardTopN, forceNew: true, mode: 'current' });
}

async function maybeWeeklyAnnouncement(guild, channel, { topN = 10, hour = 22 } = {}) {
  const now = new Date();
  const ymd = fmtYmd(now);

  // Sunday at <hour>:00 local time
  const isSunday = now.getDay() === 0;
  const isHour = now.getHours() === hour;
  const isMinuteWindow = now.getMinutes() === 0;

  if (!isSunday || !isHour || !isMinuteWindow) return;

  const state = getScoreboardState(guild.id);
  if (state?.last_weekly_announce_date === ymd) return;

  const embed = await buildScoreboardEmbed(guild, { topN });
  embed.setTitle('🏆 Classement hebdo — Guildeux (pings)');
  embed.setDescription(
    (embed.data?.description || '') +
    `\n\n🏅 **GG au vainqueur !** Parlez au **meneur** pour récupérer votre gain : **30% de la banque du meneur**.`
  );
  embed.setFooter({ text: `Annonce auto — Dimanche ${String(hour).padStart(2, '0')}h + reset.` });

  await channel.send({ embeds: [embed] });

  // Archive old board, reset, and post a new fresh board under the winners message
  try {
    await rotateWeeklyBoard(guild, channel, { boardTopN: 25 });
  } catch (e) {
    console.warn('[bot] weekly rotate failed:', e?.message || e);
  }

  setLastWeeklyAnnounceDate(guild.id, ymd);
}

module.exports = {
  ensureScoreboardMessage,
  buildScoreboardEmbed,
  incrementPing,
  upsertScoreUser,
  maybeWeeklyAnnouncement,
  resetScores,
  rotateWeeklyBoard,
};
