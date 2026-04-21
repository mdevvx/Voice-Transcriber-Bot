import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
} from 'discord.js';

import { settings } from './config/settings.js';
import { logger } from './utils/logger.js';

// ── Commands ──────────────────────────────────────────────────────────────────
import { commands as vcCmds } from './commands/vcTranscript.js';

// ── Events ────────────────────────────────────────────────────────────────────
import * as evVoiceStateUpdate from './events/voiceStateUpdate.js';

// ── Client setup ──────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Command collection ────────────────────────────────────────────────────────
client.commands = new Collection();

for (const mod of vcCmds) {
  if (mod.data && mod.execute) {
    client.commands.set(mod.data.name, mod);
  }
}

// ── Register event handlers ───────────────────────────────────────────────────
const events = [evVoiceStateUpdate];

for (const ev of events) {
  const handler = (...args) => ev.execute(client, ...args);
  if (ev.once) {
    client.once(ev.name, handler);
  } else {
    client.on(ev.name, handler);
  }
}

// ── Interaction handler ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    logger.error(`Command ${interaction.commandName} error: ${err.message}`);
    const msg = { content: '❌ Something went wrong.', flags: 64 };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async c => {
  logger.info(`✅ Logged in as ${c.user.tag}`);

  const rest = new REST().setToken(settings.DISCORD_TOKEN);
  const commandsJSON = [...client.commands.values()].map(c => c.data.toJSON());

  try {
    await rest.put(
      Routes.applicationGuildCommands(c.user.id, settings.GUILD_ID),
      { body: commandsJSON }
    );
    logger.info(`Slash commands registered → guild ${settings.GUILD_ID}`);
  } catch (err) {
    logger.error(`Failed to register commands: ${err.message}`);
  }

  logger.info('Voice Transcript Bot is ready');
});

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(settings.DISCORD_TOKEN).catch(err => {
  logger.error(`Login failed: ${err.message}`);
  process.exit(1);
});
