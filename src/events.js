const db = require('./db');

function createSubmission({ guildId, authorId, participants, proofsChannelId, proofsMessageId, pendingReplyMessageId = null }) {
  const stmt = db.prepare(
    `INSERT INTO event_submissions (guild_id, author_id, participants, proofs_channel_id, proofs_message_id, pending_reply_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(guildId, authorId, participants, proofsChannelId, proofsMessageId, pendingReplyMessageId, Date.now());
  return info.lastInsertRowid;
}

function setStaffMessageId(id, staffMessageId) {
  db.prepare(`UPDATE event_submissions SET staff_message_id=? WHERE id=?`).run(staffMessageId, id);
}

function setStaffControlMessageId(id, staffControlMessageId) {
  db.prepare(`UPDATE event_submissions SET staff_control_message_id=? WHERE id=?`).run(staffControlMessageId, id);
}

function setScreenMessageId(id, screenMessageId) {
  db.prepare(`UPDATE event_submissions SET screen_message_id=? WHERE id=?`).run(screenMessageId, id);
}

function setPendingReplyMessageId(id, pendingReplyMessageId) {
  db.prepare(`UPDATE event_submissions SET pending_reply_message_id=? WHERE id=?`).run(pendingReplyMessageId, id);
}

function setParticipantsOverride(id, participantsOverride) {
  db.prepare(`UPDATE event_submissions SET participants_override=? WHERE id=?`).run(participantsOverride, id);
}

function setDefendersPresent(id, defendersPresent) {
  db.prepare(`UPDATE event_submissions SET defenders_present=? WHERE id=?`).run(defendersPresent, id);
}

function getSubmission(id) {
  return db.prepare(`SELECT * FROM event_submissions WHERE id=?`).get(id);
}

function claimForApply(id, validatedBy) {
  // Atomic claim to prevent double-apply spam
  const info = db.prepare(
    `UPDATE event_submissions
     SET status='applying', validated_by=?, validated_at=?
     WHERE id=? AND status='pending'`
  ).run(validatedBy, Date.now(), id);
  return info.changes || 0;
}

function markApproved(id, { points, validatedBy }) {
  db.prepare(
    `UPDATE event_submissions
     SET status='approved', points=?, validated_by=?, validated_at=?
     WHERE id=?`
  ).run(points, validatedBy, Date.now(), id);
}

function listAwards(guildId, submissionId) {
  return db.prepare(
    `SELECT user_id, points FROM event_awards WHERE guild_id=? AND submission_id=?`
  ).all(guildId, submissionId);
}

function clearAwards(guildId, submissionId) {
  const rows = listAwards(guildId, submissionId);
  // rollback user totals
  for (const r of rows) {
    addPoints(guildId, r.user_id, -Number(r.points || 0));
  }
  db.prepare(`DELETE FROM event_awards WHERE guild_id=? AND submission_id=?`).run(guildId, submissionId);
  return rows;
}

function claimForFix(id, validatedBy) {
  // Prevent multiple staff applying a correction simultaneously.
  // We allow fixing an already-approved submission.
  const info = db.prepare(
    `UPDATE event_submissions
     SET status='fixing', validated_by=?, validated_at=?
     WHERE id=? AND status='approved'`
  ).run(validatedBy, Date.now(), id);
  return info.changes || 0;
}

function applyAwards(guildId, submissionId, userIds, points) {
  const uniq = [...new Set((userIds || []).map(String))].filter(Boolean);
  const p = Number(points || 0);
  const now = Date.now();
  for (const uid of uniq) {
    addPoints(guildId, uid, p);
    db.prepare(
      `INSERT INTO event_awards (guild_id, submission_id, user_id, points, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, submission_id, user_id) DO UPDATE SET points=excluded.points, created_at=excluded.created_at`
    ).run(guildId, submissionId, uid, p, now);
  }
  return uniq.length;
}

function markDenied(id, { validatedBy, reason }) {
  db.prepare(
    `UPDATE event_submissions
     SET status='denied', validated_by=?, validated_at=?, deny_reason=?
     WHERE id=?`
  ).run(validatedBy, Date.now(), reason || null, id);
}

function addPoints(guildId, userId, delta) {
  db.prepare(
    `INSERT INTO event_scores (guild_id, user_id, points, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points=points+excluded.points, updated_at=excluded.updated_at`
  ).run(guildId, userId, delta, Date.now());
}

function setPoints(guildId, userId, points) {
  db.prepare(
    `INSERT INTO event_scores (guild_id, user_id, points, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET points=excluded.points, updated_at=excluded.updated_at`
  ).run(guildId, userId, points, Date.now());
}

function removeUser(guildId, userId) {
  db.prepare(`DELETE FROM event_scores WHERE guild_id=? AND user_id=?`).run(guildId, userId);
}

function getUserScore(guildId, userId) {
  return db.prepare(`SELECT user_id, points FROM event_scores WHERE guild_id=? AND user_id=?`).get(guildId, userId);
}

function listScores(guildId, limit = 25) {
  return db.prepare(
    `SELECT user_id, points FROM event_scores WHERE guild_id=? ORDER BY points DESC, user_id ASC LIMIT ?`
  ).all(guildId, limit);
}

function getScoreboardState(guildId) {
  return db.prepare(`SELECT guild_id, channel_id, message_id FROM event_scoreboard_state WHERE guild_id=?`).get(guildId);
}

function listSubmissionsForReset(guildId) {
  return db.prepare(
    `SELECT id, proofs_channel_id, proofs_message_id, staff_message_id, staff_control_message_id, screen_message_id
     FROM event_submissions WHERE guild_id=?`
  ).all(guildId);
}

function resetGuild(guildId) {
  // Hard reset: clears scores + submissions + drafts + scoreboard state + awards
  db.prepare(`DELETE FROM event_awards WHERE guild_id=?`).run(guildId);
  db.prepare(`DELETE FROM event_scores WHERE guild_id=?`).run(guildId);
  db.prepare(`DELETE FROM event_submissions WHERE guild_id=?`).run(guildId);
  db.prepare(`DELETE FROM event_drafts WHERE guild_id=?`).run(guildId);
  db.prepare(`DELETE FROM event_scoreboard_state WHERE guild_id=?`).run(guildId);
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
  setStaffControlMessageId,
  setScreenMessageId,
  setPendingReplyMessageId,
  setDefendersPresent,
  setParticipantsOverride,
  getSubmission,
  claimForApply,
  markApproved,
  markDenied,
  listAwards,
  clearAwards,
  claimForFix,
  applyAwards,
  addPoints,
  setPoints,
  removeUser,
  getUserScore,
  listScores,
  getScoreboardState,
  setScoreboardState,
  listSubmissionsForReset,
  resetGuild,
};
