const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-multiguild-'));
process.env.DISCORD_TOKEN = 'offline-test-token';
process.env.GUILD_ID = '100000000000000001';
process.env.GUILD_IDS = '100000000000000002, 100000000000000001,100000000000000003';
process.env.DEFAULT_CHANNEL_ID = '200000000000000001';
process.env.ALERT_CHANNEL_ID = '200000000000000002';
process.env.DEF_ROLE_ID = '300000000000000001';
process.env.GUILDEUX_ROLE_ID = '300000000000000002';
process.env.SCOREBOARD_CHANNEL_ID = '200000000000000003';
process.env.ADMIN_ROLE_IDS = '300000000000000003';
process.env.DB_PATH = path.join(temp, 'test.sqlite');
process.env.DRAGODINDE_DATA_DIR = path.join(temp, 'dragodinde');
process.env.METIERS_DATA_DIR = path.join(temp, 'metiers');
process.env.LOG_TO_FILE = 'false';
fs.mkdirSync(process.env.DRAGODINDE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.METIERS_DATA_DIR, { recursive: true });

const config = require('../src/config');
const db = require('../src/db');
const { getConfigForGuild } = require('../src/runtimeConfig');
const { updateGuildConfig } = require('../src/guildConfig');
const dragodinde = require('../src/dragodinde');
const metiers = require('../src/metiers');

test('GUILD_IDS extends and deduplicates legacy GUILD_ID', () => {
  assert.deepEqual(config.guildIds, [
    '100000000000000002',
    '100000000000000001',
    '100000000000000003',
  ]);
  assert.equal(config.guildId, '100000000000000001');
});

test('legacy IDs apply only to the primary guild', () => {
  const primary = getConfigForGuild('100000000000000001');
  const secondary = getConfigForGuild('100000000000000002');
  assert.equal(primary.panelChannelId, '200000000000000001');
  assert.equal(primary.defRoleId, '300000000000000001');
  assert.equal(secondary.panelChannelId, null);
  assert.equal(secondary.alertChannelId, null);
  assert.equal(secondary.defRoleId, null);
  assert.deepEqual(secondary.adminRoleIdsLegacy, []);
});

test('guild configuration rows do not inherit from each other', () => {
  updateGuildConfig('100000000000000002', { panel_channel_id: '200000000000000099' });
  assert.equal(getConfigForGuild('100000000000000002').panelChannelId, '200000000000000099');
  assert.equal(getConfigForGuild('100000000000000003').panelChannelId, null);
});

test('Dragodinde finance is isolated by guildId', () => {
  dragodinde._test.addUserDebt('100000000000000001', 'user-1', 55_000);
  assert.equal(dragodinde._test.getUserDebt('100000000000000001', 'user-1'), 55_000);
  assert.equal(dragodinde._test.getUserDebt('100000000000000002', 'user-1'), 0);
});

test('métiers users and emoji mappings are isolated by guildId', () => {
  metiers.writeUsersDb('100000000000000001', { version: 1, users: { same: { jobs: [{ key: 'mineur' }] } } });
  metiers.writeUsersDb('100000000000000002', { version: 1, users: { same: { jobs: [{ key: 'paysan' }] } } });
  assert.equal(metiers.readUsersDb('100000000000000001').users.same.jobs[0].key, 'mineur');
  assert.equal(metiers.readUsersDb('100000000000000002').users.same.jobs[0].key, 'paysan');

  metiers.writeEmojisMap('100000000000000001', { version: 1, emojis: { mineur: 'emoji-a' } });
  metiers.writeEmojisMap('100000000000000002', { version: 1, emojis: { mineur: 'emoji-b' } });
  assert.equal(metiers.readEmojisMap('100000000000000001').emojis.mineur, 'emoji-a');
  assert.equal(metiers.readEmojisMap('100000000000000002').emojis.mineur, 'emoji-b');
});

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
