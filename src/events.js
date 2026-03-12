const db = require('./db');

function createSubmission({ guildId, authorId, participants, proofsChannelId, proofsMessageId }) {
  const stmt = db.prepare(
    `INSERT INTO event_submissions (guild_id, author_id, participants, proofs_channel_id, proofs_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(guildId, authorId, participants, proofsChannelId, proofsMessageId, Date.now());
  return info.lastInsertRowid;
}

function setStaffMessageId(id, staffMessageId) {
  db.prepare(`UPDATE event_submissions SET staff_message_id=? WHERE id=?`).run(staffMessageId, id);
}

function setDefendersPresent(id, defendersPresent) {
  db.prepare(`UPDATE event_submissions SET defenders_present=? WHERE id=?`).run(defendersPresent, id);
}

function getSubmission(id) {
  return db.prepare(`SELECT * FROM event_submissions WHERE id=?`).get(id);
}

function markApproved(id, { points, validatedBy }) {
  db.prepare(
    `UPDATE event_submissions
     SET status='approved', points=?, validated_by=?, validated_at=?
     WHERE id=?`
  ).run(points, validatedBy, Date.now(), id);
}

function markDenied(id, { validatedBy }) {
  db.prepare(
    `UPDATE event_submissions
     SET status='denied', validated_by=?, validated_at=?
     WHERE id=?`
  ).run(validatedBy, Date.now(), id);
}

function addPoints(guildId, userId, delta) {
  db.prepare(
    `INSERT INTO event_scores (guild_id, user_id, points, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points=points+excluded.points, updated_at=excluded.updated_at`
  ).run(guildId, userId, delta, Date.now());
}

function listScores(guildId, limit = 25) {
  return db.prepare(
    `SELECT user_id, points FROM event_scores WHERE guild_id=? ORDER BY points DESC, user_id ASC LIMIT ?`
  ).all(guildId, limit);
}

function getScoreboardState(guildId) {
  return db.prepare(`SELECT guild_id, channel_id, message_id FROM event_scoreboard_state WHERE guild_id=?`).get(guildId);
}

function setScoreboardState(guildId, channelId, messageId) {
  db.prepare(
    `INSERT INTO event_scoreboard_state (guild_id, channel_id, message_id)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, message_id=excluded.message_id`
  ).run(guildId, channelId, messageId);
}

module.exports = {
  createSubmission,
  setStaffMessageId,
  setDefendersPresent,
  getSubmission,
  markApproved,
  markDenied,
  addPoints,
  listScores,
  getScoreboardState,
  setScoreboardState,
};
