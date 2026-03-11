const db = require('./db');

function upsertProfile(guildId, userId, ign) {
  const v = String(ign || '').trim();
  db.prepare(
    `INSERT INTO player_profiles (guild_id, user_id, ign, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET ign=excluded.ign, updated_at=excluded.updated_at`
  ).run(guildId, userId, v, Date.now());
}

function appendToProfile(guildId, userId, ignsToAdd) {
  const current = getProfile(guildId, userId);
  const existing = current?.ign ? String(current.ign) : '';

  const add = String(ignsToAdd || '')
    .split(/\r?\n|,/)
    .map(s => s.trim())
    .filter(Boolean);

  const merged = [
    ...existing.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean),
    ...add,
  ];

  // Deduplicate (case-insensitive) while preserving order
  const seen = new Set();
  const uniq = [];
  for (const x of merged) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(x);
  }

  upsertProfile(guildId, userId, uniq.join('\n'));
  return getProfile(guildId, userId);
}

function getProfile(guildId, userId) {
  return db.prepare(
    `SELECT guild_id, user_id, ign, updated_at, profile_message_id FROM player_profiles WHERE guild_id=? AND user_id=?`
  ).get(guildId, userId);
}

function setProfileMessageId(guildId, userId, messageId) {
  db.prepare(
    `UPDATE player_profiles SET profile_message_id=?, updated_at=? WHERE guild_id=? AND user_id=?`
  ).run(messageId, Date.now(), guildId, userId);
}

function deleteProfile(guildId, userId) {
  const existing = getProfile(guildId, userId);
  db.prepare(`DELETE FROM player_profiles WHERE guild_id=? AND user_id=?`).run(guildId, userId);
  return existing;
}

module.exports = {
  upsertProfile,
  appendToProfile,
  getProfile,
  setProfileMessageId,
  deleteProfile,
};
