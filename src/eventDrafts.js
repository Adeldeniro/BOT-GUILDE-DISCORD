const db = require('./db');

function setDraft({ guildId, authorId, threadId, participants }) {
  db.prepare(
    `INSERT INTO event_drafts (guild_id, author_id, thread_id, participants, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, author_id) DO UPDATE SET thread_id=excluded.thread_id, participants=excluded.participants, created_at=excluded.created_at`
  ).run(guildId, authorId, threadId, participants, Date.now());
}

function getDraft(guildId, authorId) {
  return db.prepare(`SELECT * FROM event_drafts WHERE guild_id=? AND author_id=?`).get(guildId, authorId);
}

function clearDraft(guildId, authorId) {
  db.prepare(`DELETE FROM event_drafts WHERE guild_id=? AND author_id=?`).run(guildId, authorId);
}

module.exports = {
  setDraft,
  getDraft,
  clearDraft,
};
