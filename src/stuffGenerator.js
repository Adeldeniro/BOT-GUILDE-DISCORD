const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog_pvp_display_quota.json');

function norm(s) {
  return (s || '').toString().trim().toLowerCase();
}

function loadCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  const catalog = JSON.parse(raw);
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  return { catalog, items, catalogPath };
}

function newSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

function score(x) {
  const pdv = x?.display?.pdv || 0;
  const r = x?.display?.res || {};
  const rs = (r.neutre || 0) + (r.terre || 0) + (r.eau || 0) + (r.feu || 0) + (r.air || 0);
  return pdv + rs * 50;
}

function buildUI(sessionId, criteria) {
  const elementOptions = ['terre', 'feu', 'eau', 'air', 'multi', 'dopou', 'docrit'];
  const paChoices = ['11', '12'];
  const pmChoices = ['5', '6'];

  const elementMenu = new StringSelectMenuBuilder()
    .setCustomId(`gs:elem:${sessionId}`)
    .setPlaceholder('Élément')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      elementOptions.map((e) => ({
        label: e,
        value: e,
        default: Boolean(criteria?.element && norm(e) === norm(criteria.element)),
      })),
    );

  const paMenu = new StringSelectMenuBuilder()
    .setCustomId(`gs:pa:${sessionId}`)
    .setPlaceholder('PA (11 ou 12)')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      paChoices.map((v) => ({
        label: `${v} PA`,
        value: v,
        default: Boolean(criteria?.pa && String(criteria.pa) === v),
      })),
    );

  const pmMenu = new StringSelectMenuBuilder()
    .setCustomId(`gs:pm:${sessionId}`)
    .setPlaceholder('PM (5 ou 6)')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      pmChoices.map((v) => ({
        label: `${v} PM`,
        value: v,
        default: Boolean(criteria?.pm && String(criteria.pm) === v),
      })),
    );

  const regenBtn = new ButtonBuilder()
    .setCustomId(`gs:regen:${sessionId}`)
    .setLabel('⟲ Autres 10')
    .setStyle(ButtonStyle.Primary);

  return [
    new ActionRowBuilder().addComponents(elementMenu),
    new ActionRowBuilder().addComponents(paMenu),
    new ActionRowBuilder().addComponents(pmMenu),
    new ActionRowBuilder().addComponents(regenBtn),
  ];
}

function filterItems(items, criteria) {
  let out = items;

  if (criteria.element) {
    const e = norm(criteria.element);
    if (['dopou', 'docrit'].includes(e)) {
      out = out.filter((x) => Array.isArray(x.tags) && x.tags.map(norm).includes(e));
    } else {
      out = out.filter((x) => norm(x.element) === e);
    }
  }

  if (criteria.pa) {
    out = out.filter((x) => String(x?.display?.pa ?? '') === String(criteria.pa));
  }

  if (criteria.pm) {
    out = out.filter((x) => String(x?.display?.pm ?? '') === String(criteria.pm));
  }

  return out;
}

function pick10(items, alreadyShown) {
  const shown = alreadyShown || new Set();
  const top = items.slice().sort((a, b) => score(b) - score(a)).slice(0, 200);
  const pool = top.filter((x) => !shown.has(String(x.stuff_id)));
  const effectivePool = pool.length ? pool : top;

  for (let i = effectivePool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [effectivePool[i], effectivePool[j]] = [effectivePool[j], effectivePool[i]];
  }

  return effectivePool.slice(0, 10);
}

function buildResultsEmbed(list, criteria) {
  const elem = criteria.element || '—';
  const pa = criteria.pa || '—';
  const pm = criteria.pm || '—';

  const embed = new EmbedBuilder()
    .setTitle('Générateur de stuff — Résultats')
    .setDescription(`Élément: **${elem}**  •  PA: **${pa}**  •  PM: **${pm}**`)
    .setColor(0x5865F2);

  if (!list.length) {
    embed.addFields({ name: 'Aucun résultat', value: 'Essaie un autre élément ou un autre couple PA/PM.' });
    return embed;
  }

  const value = list.map((x, i) => {
    const pdv = x?.display?.pdv ?? '?';
    const r = x?.display?.res || {};
    const paV = x?.display?.pa ?? '?';
    const pmV = x?.display?.pm ?? '?';
    return [
      `**#${i + 1}** — **PdV ${pdv}**  •  **${paV}PA/${pmV}PM** — [Ouvrir](${x.url})`,
      `Res **N/T/E/F/A**: ${r.neutre ?? 0}/${r.terre ?? 0}/${r.eau ?? 0}/${r.feu ?? 0}/${r.air ?? 0}`,
    ].join('\n');
  }).join('\n\n');

  embed.addFields({ name: 'Top 10', value });
  return embed;
}

function buildRegenOnlyRow(sessionId) {
  const regenBtn = new ButtonBuilder()
    .setCustomId(`gs:regen:${sessionId}`)
    .setLabel('⟲ Autres 10')
    .setStyle(ButtonStyle.Primary);

  return [new ActionRowBuilder().addComponents(regenBtn)];
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  loadCatalog,
  newSessionId,
  buildUI,
  filterItems,
  pick10,
  buildResultsEmbed,
  buildRegenOnlyRow,
};
