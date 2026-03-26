'use strict';

require('dotenv').config();
const { REST, Routes } = require('@discordjs/rest');
const fs = require('fs');
const path = require('path');

const commands = [];

function loadCommandData(dir) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      loadCommandData(fullPath);
    } else if (item.name.endsWith('.js')) {
      try {
        const command = require(fullPath);
        if (command.data) {
          commands.push(command.data.toJSON());
          console.log(`  ✅ Loaded: /${command.data.name}`);
        }
      } catch (err) {
        console.error(`  ❌ Failed: ${fullPath} — ${err.message}`);
      }
    }
  }
}

async function deploy() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId) {
    console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env');
    process.exit(1);
  }

  console.log('Loading command definitions...');
  loadCommandData(path.join(__dirname, 'commands'));

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    if (guildId) {
      // Guild-specific deployment (instant, for dev)
      console.log(`\nDeploying ${commands.length} commands to guild ${guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`✅ Deployed ${commands.length} guild commands (instant refresh).`);
    } else {
      // Global deployment (1-hour cache, for production)
      console.log(`\nDeploying ${commands.length} commands globally...`);
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`✅ Deployed ${commands.length} global commands (up to 1h to propagate).`);
    }
  } catch (err) {
    console.error('Deploy failed:', err);
    process.exit(1);
  }
}

deploy();
