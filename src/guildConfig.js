const db = require('./db');

function ensureRow(guildId) {
  db.prepare(
    `INSERT INTO guild_config (guild_id) VALUES (?)
     ON CONFLICT(guild_id) DO NOTHING`
  ).run(guildId);
}

function getGuildConfig(guildId) {
  ensureRow(guildId);
  return db.prepare(
    `SELECT * FROM guild_config WHERE guild_id=?`
  ).get(guildId);
}

function updateGuildConfig(guildId, patch) {
  ensureRow(guildId);

  const keys = Object.keys(patch);
  if (!keys.length) return getGuildConfig(guildId);

  const sets = keys.map(k => `${k}=?`).join(', ');
  const values = keys.map(k => patch[k]);
  db.prepare(`UPDATE guild_config SET ${sets} WHERE guild_id=?`).run(...values, guildId);
  return getGuildConfig(guildId);
}

module.exports = {
  getGuildConfig,
  updateGuildConfig,
};
