const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
} = require('discord.js');
const db = require('./db');

const DEFAULT_SUFFIX = '🌟';

function normalizeSuffix(suffix) {
  return String(suffix || DEFAULT_SUFFIX).trim() || DEFAULT_SUFFIX;
}

function suffixToken(suffix) {
  return ` ${normalizeSuffix(suffix)}`;
}

function formatDateFr(ts) {
  if (!ts) return null;
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Europe/Paris',
    }).format(new Date(Number(ts)));
  } catch {
    return new Date(Number(ts)).toISOString();
  }
}

function cooldownLabel(mode) {
  switch (String(mode || 'none')) {
    case '1d': return '1 jour';
    case '3d': return '3 jours';
    case '7d': return '1 semaine';
    case '30d': return '1 mois';
    case 'never': return 'Plus jamais';
    default: return 'Aucune limitation';
  }
}

function computeRetryAfter(mode, now = Date.now()) {
  switch (String(mode || 'none')) {
    case '1d': return now + 24 * 60 * 60 * 1000;
    case '3d': return now + 3 * 24 * 60 * 60 * 1000;
    case '7d': return now + 7 * 24 * 60 * 60 * 1000;
    case '30d': return now + 30 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function getApplication(id) {
  return db.prepare('SELECT * FROM elite_applications WHERE id=?').get(id);
}

function getLatestApplication(guildId, userId) {
  return db.prepare(
    `SELECT *
     FROM elite_applications
     WHERE guild_id=? AND user_id=?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).get(guildId, userId);
}

function getPendingApplication(guildId, userId) {
  return db.prepare(
    `SELECT *
     FROM elite_applications
     WHERE guild_id=? AND user_id=? AND status='pending'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  ).get(guildId, userId);
}

function evaluateEligibility({ guildId, userId, hasEliteRole }) {
  if (hasEliteRole) {
    return { ok: false, code: 'already_elite' };
  }

  const pending = getPendingApplication(guildId, userId);
  if (pending) {
    return { ok: false, code: 'pending', application: pending };
  }

  const latest = getLatestApplication(guildId, userId);
  if (!latest) return { ok: true, code: 'ok' };

  if (Number(latest.locked_forever || 0) === 1 || String(latest.retry_mode || '') === 'never') {
    return { ok: false, code: 'blocked_forever', application: latest };
  }

  const retryAfter = Number(latest.retry_after || 0);
  if (latest.status === 'refused' && retryAfter && retryAfter > Date.now()) {
    return { ok: false, code: 'cooldown', retryAfter, application: latest };
  }

  return { ok: true, code: 'ok', application: latest };
}

function createApplication({ guildId, userId }) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO elite_applications (
      guild_id, user_id, status, created_at, retry_mode, locked_forever
    ) VALUES (?, ?, 'pending', ?, 'none', 0)`
  ).run(guildId, userId, now);
  return getApplication(info.lastInsertRowid);
}

function setStaffMessageId(id, staffMessageId) {
  db.prepare('UPDATE elite_applications SET staff_message_id=? WHERE id=?').run(staffMessageId || null, id);
  return getApplication(id);
}

function deleteApplication(id) {
  db.prepare('DELETE FROM elite_applications WHERE id=?').run(id);
}

function markAccepted(id, { reviewedBy, nicknameBefore = null }) {
  const now = Date.now();
  db.prepare(
    `UPDATE elite_applications
     SET status='accepted',
         reviewed_at=?,
         reviewed_by=?,
         staff_comment=NULL,
         retry_mode='none',
         retry_after=NULL,
         locked_forever=0,
         nickname_before=COALESCE(?, nickname_before)
     WHERE id=?`
  ).run(now, reviewedBy, nicknameBefore, id);
  return getApplication(id);
}

function markRefused(id, { reviewedBy, comment = '', retryMode = 'none' }) {
  const now = Date.now();
  const mode = String(retryMode || 'none');
  const lockedForever = mode === 'never' ? 1 : 0;
  const retryAfter = lockedForever ? null : computeRetryAfter(mode, now);

  db.prepare(
    `UPDATE elite_applications
     SET status='refused',
         reviewed_at=?,
         reviewed_by=?,
         staff_comment=?,
         retry_mode=?,
         retry_after=?,
         locked_forever=?
     WHERE id=?`
  ).run(now, reviewedBy, String(comment || '').trim() || null, mode, retryAfter, lockedForever, id);
  return getApplication(id);
}

function stripEliteSuffix(name, suffix) {
  const token = suffixToken(suffix);
  const value = String(name || '').trimEnd();
  return value.endsWith(token) ? value.slice(0, -token.length).trimEnd() : value;
}

function applyEliteSuffix(name, suffix) {
  const token = suffixToken(suffix);
  const raw = stripEliteSuffix(name, suffix) || String(name || '').trim() || 'Membre';
  const maxBaseLength = Math.max(1, 32 - token.length);
  const base = raw.slice(0, maxBaseLength).trimEnd() || raw.slice(0, maxBaseLength) || 'Membre';
  return `${base}${token}`.slice(0, 32);
}

async function ensureEliteSuffix(member, rc) {
  const suffix = normalizeSuffix(rc?.eliteSuffix);
  const current = member.nickname ?? member.user?.globalName ?? member.user?.username ?? 'Membre';
  const next = applyEliteSuffix(current, suffix);
  if (current === next) return { changed: false, previous: current, next };
  if (!member.manageable) {
    return { changed: false, previous: current, next, blocked: true };
  }
  await member.setNickname(next, 'Validation ELITE').catch(() => {});
  return { changed: true, previous: current, next };
}

async function removeEliteSuffix(member, rc) {
  const suffix = normalizeSuffix(rc?.eliteSuffix);
  const current = member.nickname ?? member.user?.globalName ?? member.user?.username ?? 'Membre';
  const next = stripEliteSuffix(current, suffix);
  if (current === next) return { changed: false, previous: current, next };
  if (!member.manageable) {
    return { changed: false, previous: current, next, blocked: true };
  }
  await member.setNickname(next || null, 'Retrait ELITE').catch(() => {});
  return { changed: true, previous: current, next };
}

async function syncNicknameForRoleChange(oldMember, newMember, rc) {
  if (!rc?.eliteRoleId) return;
  const hadRole = oldMember.roles.cache.has(rc.eliteRoleId);
  const hasRole = newMember.roles.cache.has(rc.eliteRoleId);
  if (hadRole === hasRole) return;
  if (hasRole) {
    await ensureEliteSuffix(newMember, rc);
  } else {
    await removeEliteSuffix(newMember, rc);
  }
}

function buildPanelEmbed(rc) {
  const suffix = normalizeSuffix(rc?.eliteSuffix);
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🌟 Candidature ELITE')
    .setDescription(
      'Les **[ELITE]** représentent la première ligne de défense de la guilde.\n' +
      'Si tu veux te proposer, envoie ta candidature avec le bouton ci-dessous.\n\n' +
      `Après validation, ton pseudo sera affiché au format **Pseudo ${suffix}**.`
    )
    .addFields(
      { name: 'Processus', value: '• Candidature\n• Validation staff\n• Attribution du rôle\n• Suffixe ajouté au pseudo', inline: false },
      { name: 'Important', value: '• Une seule demande en attente à la fois\n• Les refus peuvent inclure un délai avant nouvelle demande', inline: false },
    )
    .setFooter({ text: 'Utilise "Voir le statut" pour suivre ta demande en privé.' });
}

function buildPanelComponents(guildId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`elite:apply:${guildId}`).setLabel('Se proposer').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`elite:status:${guildId}`).setLabel('Voir le statut de ma demande').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildStaffComponents(appId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`eliteadm:${appId}:approve`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`eliteadm:${appId}:deny`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildCooldownComponents(appId) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`elitecool:${appId}`)
        .setPlaceholder('Choisir le délai avant nouvelle demande')
        .addOptions(
          { label: 'Aucune limitation', value: 'none' },
          { label: '1 jour', value: '1d' },
          { label: '3 jours', value: '3d' },
          { label: '1 semaine', value: '7d' },
          { label: '1 mois', value: '30d' },
          { label: 'Plus jamais', value: 'never' },
        ),
    ),
  ];
}

function buildRefusalModal(appId, retryMode) {
  const modal = new ModalBuilder()
    .setCustomId(`elitecomment:${appId}:${retryMode}`)
    .setTitle('Refus candidature ELITE');
  const comment = new TextInputBuilder()
    .setCustomId('comment')
    .setLabel('Commentaire staff (optionnel)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000)
    .setPlaceholder('Explique brièvement la décision ou la marche à suivre.');
  modal.addComponents(new ActionRowBuilder().addComponents(comment));
  return modal;
}

function buildStaffEmbed(member, application, rc) {
  const suffix = normalizeSuffix(rc?.eliteSuffix);
  const statusMap = {
    pending: '🟡 En attente',
    accepted: '✅ Acceptée',
    refused: '❌ Refusée',
  };

  const createdAt = formatDateFr(application.created_at) || '—';
  const reviewedAt = formatDateFr(application.reviewed_at) || '—';
  const retryAfter = formatDateFr(application.retry_after);
  const comment = String(application.staff_comment || '').trim();

  const embed = new EmbedBuilder()
    .setColor(application.status === 'accepted' ? 0x2ecc71 : application.status === 'refused' ? 0xe74c3c : 0xf1c40f)
    .setTitle('🌟 Candidature ELITE')
    .setDescription(
      `Membre : <@${application.user_id}>\n` +
      `Statut : **${statusMap[application.status] || application.status}**\n` +
      `Pseudo visé : **${(member?.displayName || 'Membre')} ${suffix}**`
    )
    .addFields(
      { name: 'Infos', value: `• ID: \`${application.user_id}\`\n• Créée le: ${createdAt}`, inline: false },
    )
    .setFooter({ text: application.status === 'pending' ? 'Validation staff requise.' : 'Candidature traitée.' })
    .setTimestamp();

  if (member?.user?.displayAvatarURL) {
    embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  }

  if (application.status !== 'pending') {
    const lines = [
      `• Traité le: ${reviewedAt}`,
      application.reviewed_by ? `• Par: <@${application.reviewed_by}>` : null,
      `• Redemande: ${cooldownLabel(application.retry_mode)}`,
      retryAfter ? `• Reprise possible: ${retryAfter}` : null,
      Number(application.locked_forever || 0) === 1 ? '• Blocage: permanent' : null,
    ].filter(Boolean);
    embed.addFields({ name: 'Décision', value: lines.join('\n').slice(0, 1024), inline: false });
    if (comment) {
      embed.addFields({ name: 'Commentaire staff', value: comment.slice(0, 1024), inline: false });
    }
  }

  return embed;
}

function buildStatusMessage(application) {
  if (!application) {
    return 'Tu n’as actuellement aucune demande ELITE enregistrée.';
  }

  if (application.status === 'pending') {
    return 'Ta demande ELITE est actuellement **en attente** de validation par le staff.';
  }

  if (application.status === 'accepted') {
    return 'Ta demande ELITE a été **acceptée**. Bienvenue parmi les **[ELITE]**.';
  }

  const comment = String(application.staff_comment || '').trim();
  const retryAfter = Number(application.retry_after || 0);
  const pieces = ['Ta demande ELITE a été **refusée**.'];
  if (comment) pieces.push(`Motif : ${comment}`);
  if (Number(application.locked_forever || 0) === 1 || String(application.retry_mode || '') === 'never') {
    pieces.push('Tu ne peux plus soumettre de nouvelle demande pour ce rôle.');
  } else if (retryAfter && retryAfter > Date.now()) {
    pieces.push(`Tu pourras refaire une demande à partir du **${formatDateFr(retryAfter)}**.`);
  } else {
    pieces.push('Tu peux refaire une demande quand tu le souhaites.');
  }
  return pieces.join('\n');
}

module.exports = {
  applyEliteSuffix,
  buildCooldownComponents,
  buildPanelComponents,
  buildPanelEmbed,
  buildRefusalModal,
  buildStaffComponents,
  buildStaffEmbed,
  buildStatusMessage,
  cooldownLabel,
  createApplication,
  deleteApplication,
  evaluateEligibility,
  formatDateFr,
  getApplication,
  getLatestApplication,
  markAccepted,
  markRefused,
  normalizeSuffix,
  removeEliteSuffix,
  setStaffMessageId,
  stripEliteSuffix,
  syncNicknameForRoleChange,
  ensureEliteSuffix,
};
