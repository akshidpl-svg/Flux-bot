import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('gives every registered command a real handler', () => {
    for (const command of commands) {
      assert.equal(typeof command.execute, 'function', `/${command.data.name} has no execute()`);
      const json = command.data.toJSON();
      const subs = (json.options ?? [])
        .filter((option) => option.type === 1 || option.type === 2)
        .map((option) => option.name);
      assert.equal(new Set(subs).size, subs.length, `/${json.name} declares duplicate subcommands`);
    }
  });

  it('handles every declared subcommand in its own module', () => {
    const modules: Record<string, string> = {
      wallet: 'wallet.ts',
      cancel: 'social.ts',
      alert: 'market.ts',
      notify: 'user.ts',
      server: 'server.ts',
      admin: 'admin.ts',
    };
    for (const command of commands) {
      const json = command.data.toJSON();
      const subs = (json.options ?? []).filter((option) => option.type === 1 || option.type === 2);
      if (subs.length < 2) continue; // A single-subcommand command is handled by construction.
      const file = modules[json.name];
      assert.ok(file, `unknown module for /${json.name}`);
      const source = readFileSync(new URL(`../src/discord/commands/${file}`, import.meta.url), 'utf8');
      for (const sub of subs) {
        const handled = new RegExp(`(===|!==|\\?\\?|case|as|\\|)\\s*'${sub.name}'`).test(source);
        assert.ok(handled, `/${json.name} ${sub.name} is declared but never handled in ${file}`);
      }
    }
  });

  it('validates payloads against Discord application-command rules', () => {
    const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
    const validate = (options: unknown[] | undefined, where: string, topLevel: boolean) => {
      const list = (options ?? []) as {
        name: string;
        description: string;
        type: number;
        required?: boolean;
        options?: unknown[];
        choices?: { name: string; value: unknown }[];
      }[];
      if (topLevel) assert.ok(list.length <= 25, `${where}: max 25 options`);
      let seenOptional = false;
      for (const option of list) {
        assert.match(option.name, NAME, `${where}: option name`);
        assert.ok(option.description.length >= 1 && option.description.length <= 100, `${where}/${option.name}: description`);
        if (option.required) {
          assert.equal(seenOptional, false, `${where}/${option.name}: required options must come first`);
        } else if (option.type !== 1 && option.type !== 2) {
          seenOptional = true;
        }
        if (option.choices) {
          assert.ok(option.choices.length <= 25, `${where}/${option.name}: max 25 choices`);
          for (const choice of option.choices) {
            assert.ok(choice.name.length >= 1 && choice.name.length <= 100, `${where}/${option.name}: choice name`);
            if (typeof choice.value === 'string') assert.ok(choice.value.length <= 100, `${where}/${option.name}: choice value`);
          }
        }
        if (option.type === 1 || option.type === 2) {
          assert.ok((option.options?.length ?? 0) <= 25, `${where}/${option.name}: max 25 options`);
          validate(option.options, `${where}/${option.name}`, false);
        }
      }
    };
    for (const payload of commandPayloads()) {
      assert.match(payload.name, NAME, 'command name');
      assert.ok(payload.description.length >= 1 && payload.description.length <= 100, `/${payload.name}: description`);
      validate(payload.options, `/${payload.name}`, true);
    }
  });

  it('agrees with /help and /cmds about what exists', () => {
    for (const isAdmin of [false, true]) {
      const registered = registeredCommands(isAdmin).map((command) => command.data.name);
      const helpNames = commandsByCategory(isAdmin).flatMap((category) => category.commands.map((command) => command.name));
      assert.deepEqual([...helpNames].sort(), [...registered].sort(), `help coverage mismatch (admin=${isAdmin})`);
      assert.equal(new Set(helpNames).size, helpNames.length, 'help must not list duplicates');
    }
  });

  it('uses guild install + user install everywhere a DM is supported', () => {
    for (const command of commands) {
      const json = command.data.toJSON();
      if (command.guildOnly) {
        assert.deepEqual(json.contexts, [0], `/${command.data.name} must be guild-only`);
        assert.deepEqual(json.integration_types, [0], `/${command.data.name} must not offer user install`);
      } else {
        assert.deepEqual(json.contexts, [0, 1, 2], `/${command.data.name} should work in guilds, bot DMs and user-install DMs`);
        assert.deepEqual(json.integration_types, [0, 1], `/${command.data.name} should support user install`);
      }
    }
  });

  it('authorizes administrators by ID allowlist, never by name', () => {
    const config = testConfig({ ADMIN_USER_IDS: USER_A });
    assert.equal(config.adminUserIds.has(USER_A), true);
    assert.equal(config.adminUserIds.has('555555555555555555'), false);
    assert.throws(() => testConfig({ ADMIN_USER_IDS: 'someone#0001' }));
  });
});
