import { test } from 'node:test';
import assert from 'node:assert';
import { createDiscordClient, ALIASES } from '../src/discord/client.ts';
import { GatewayIntentBits } from 'discord.js';

test('ALIASES map contains expected prefixes', () => {
  assert.equal(ALIASES.get('help'), 'h');
  assert.equal(ALIASES.get('wallet'), 'wal');
  assert.equal(ALIASES.get('balance'), 'bal');
  assert.equal(ALIASES.get('deposit'), 'dep');
  assert.equal(ALIASES.get('address'), 'addr');
  assert.equal(ALIASES.get('withdraw'), 'wd');
  assert.equal(ALIASES.get('unknown'), undefined);
});

test('createDiscordClient has required intents for prefix commands', () => {
  const client = createDiscordClient();
  const options = client.options as any;
  const intents = options.intents;
  const bitfield = intents.bitfield;
  
  console.log('GatewayIntentBits.Guilds:', GatewayIntentBits.Guilds);
  console.log('GatewayIntentBits.GuildMessages:', GatewayIntentBits.GuildMessages);
  console.log('GatewayIntentBits.MessageContent:', GatewayIntentBits.MessageContent);
  console.log('Bitfield:', bitfield);
  
  // Check using the actual intent bit values
  assert.ok(intents.has(GatewayIntentBits.Guilds), 'Guilds intent should be enabled');
  assert.ok(intents.has(GatewayIntentBits.GuildMessages), 'GuildMessages intent should be enabled');
  assert.ok(intents.has(GatewayIntentBits.MessageContent), 'MessageContent intent should be enabled');
});
