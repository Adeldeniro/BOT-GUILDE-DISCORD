const db = require('./db');

function upsertProfile(guildId, userId, ign) {
  db.prepare(
    `INSERT INTO player_profiles (guild_id, user_id, ign, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET ign=excluded.ign, updated_at=excluded.updated_at`
  ).run(guildId, userId, ign, Date.now());
}

function getProfile(guildId, userId) {
  return db.prepare(
    `SELECT guild_id, user_id, ign, updated_at FROM player_profiles WHERE guild_id=? AND user_id=?`
  ).get(guildId, userId);
}

module.exports = {
  upsertProfile,
  getProfile,
};
