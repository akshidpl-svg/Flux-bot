import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commands, commandMap, commandsByCategory, commandPayloads, registeredCommands } from '../src/discord/registry.ts';
import { testConfig, USER_A } from './helpers.ts';

const REQUIRED_COMMANDS = [
  'wallet',
  'alerts',
  'balance',
  'deposit',
  'deposits',
  'address',
  'addresses',
  'addy',
  'withdraw',
  'withdrawals',
  'fees',
  'limits',
  'currency',
  'convert',
  'portfolio',
  'allocation',
  'networth',
  'qr',
  'tip',
  'send',
  'request',
  'pay',
  'rain',
  'split',
  'tipstats',
  'tipleaderboard',
  'transactions',
  'transaction',
  'receipt',
  'cancel',
  'price',
  'prices',
  'chart',
  'calculator',
  'converter',
  'gas',
  'network',
  'explorer',
  'confirmations',
  'market',
  'gainers',
  'losers',
  'alert',
  'notifications',
  'notify',
  'profile',
  'stats',
  'rank',
  'settings',
  'privacy',
  'export',
  'support',
  'help',
  'cmds',
  'ping',
  'uptime',
  'status',
  'about',
  'invite',
  'changelog',
  'report',
  'server',
  'admin',
];

describe('command registry', () => {
  it('registers every documented command exactly once', () => {
    const names = commands.map((command) => command.data.name);
    assert.equal(new Set(names).size, names.length, 'command names must be unique');
    for (const required of REQUIRED_COMMANDS) {
      assert.ok(names.includes(required), `missing /${required}`);
    }
    assert.ok(names.length <= 100, 'Discord allows at most 100 global commands');
  });

  it('builds valid application command payloads', () => {
    const payloads = commandPayloads();
    assert.equal(payloads.length, commands.length);
    for (const payload of payloads) {
      assert.ok(payload.name.length >= 1 && payload.name.length <= 32);
      assert.ok(payload.description.length >= 1 && payload.description.length <= 100);
      assert.ok(Array.isArray(payload.options) || payload.options === undefined);
    }
  });

  it('marks server and admin commands correctly', () => {
    for (const command of commands) {
      const name = command.data.name;
      if (name === 'admin') assert.equal(command.adminOnly, true);
      else assert.notEqual(command.adminOnly, true, `${name} should not be admin-only`);
      if (name === 'rain' || name === 'server') assert.equal(command.guildOnly, true);
      if (name === 'server') {
        const json = command.data.toJSON();
        assert.deepEqual(json.contexts, [0], 'server command must only be usable in guilds');
      }
    }
    assert.equal(commandMap.get('admin')?.adminOnly, true);
    assert.equal(commandMap.has('nonexistent'), false);
  });

  it('hides admin commands from the public help catalogue', () => {
    const publicNames = registeredCommands(false).map((command) => command.data.name);
    assert.ok(!publicNames.includes('admin'));
    const adminNames = registeredCommands(true).map((command) => command.data.name);
    assert.ok(adminNames.includes('admin'));

    const categories = commandsByCategory(false);
    const helpNames = categories.flatMap((category) => category.commands.map((command) => command.name));
    assert.ok(!helpNames.includes('admin'));
    assert.ok(helpNames.includes('wallet'));
  });

  it('authorizes administrators by ID allowlist, never by name', () => {
    const config = testConfig({ ADMIN_USER_IDS: USER_A });
    assert.equal(config.adminUserIds.has(USER_A), true);
    assert.equal(config.adminUserIds.has('555555555555555555'), false);
    assert.throws(() => testConfig({ ADMIN_USER_IDS: 'someone#0001' }));
  });
});
