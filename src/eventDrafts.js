const db = require('./db');

function setDraft({ guildId, authorId, threadId, participants, stage }) {
  db.prepare(
    `INSERT INTO event_drafts (guild_id, author_id, thread_id, participants, stage, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, author_id) DO UPDATE SET thread_id=excluded.thread_id, participants=excluded.participants, stage=excluded.stage, created_at=excluded.created_at`
  ).run(guildId, authorId, threadId, participants || '', stage || 'need_participants', Date.now());
}

function setStage(guildId, authorId, stage) {
  db.prepare(`UPDATE event_drafts SET stage=?, created_at=? WHERE guild_id=? AND author_id=?`).run(stage, Date.now(), guildId, authorId);
}

function setParticipants(guildId, authorId, participants) {
  db.prepare(`UPDATE event_drafts SET participants=?, created_at=? WHERE guild_id=? AND author_id=?`).run(participants || '', Date.now(), guildId, authorId);
}

function getDraft(guildId, authorId) {
  return db.prepare(`SELECT * FROM event_drafts WHERE guild_id=? AND author_id=?`).get(guildId, authorId);
}

function clearDraft(guildId, authorId) {
  db.prepare(`DELETE FROM event_drafts WHERE guild_id=? AND author_id=?`).run(guildId, authorId);
}

module.exports = {
  setDraft,
  setStage,
  setParticipants,
  getDraft,
  clearDraft,
};
