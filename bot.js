const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const STARTING_BALANCE = 500;
const BET_COOLDOWN_MS = 10_000;

const DB_FILE = './economy.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}');
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getUser(db, userId) {
  if (!db[userId]) {
    db[userId] = { balance: STARTING_BALANCE, wins: 0, losses: 0, lastBet: 0 };
  }
  return db[userId];
}

const activeGames = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your coin balance'),

  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily 200 coins'),

  new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Gamble! Pick 3 numbers (1-6) and try to match the winning number')
    .addIntegerOption(opt =>
      opt.setName('bet').setDescription('Coins to bet').setRequired(true).setMinValue(10)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top 10 richest players'),

  new SlashCommandBuilder()
    .setName('give')
    .setDescription('Give coins to another user')
    .addUserOption(opt => opt.setName('user').setDescription('Who to give to').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('How many coins').setRequired(true).setMinValue(1)),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands.map(c => c.toJSON()),
  });
  console.log('Slash commands registered!');
}

function buildPickerButtons(pickedSoFar = []) {
  const row = new ActionRowBuilder();
  for (let n = 1; n <= 6; n++) {
    const picked = pickedSoFar.includes(n);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`pick_${n}`)
        .setLabel(picked ? `✅ ${n}` : `${n}`)
        .setStyle(picked ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(picked)
    );
  }
  return [row];
}

function buildResultEmbed(userData, game, winningNumber, won, payout) {
  const dice = ['', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
  return new EmbedBuilder()
    .setTitle(won ? '🎉 YOU WON!' : '💸 YOU LOST!')
    .setColor(won ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: '🎲 Your Picks', value: game.picks.map(p => dice[p]).join('  '), inline: true },
      { name: '🏆 Winning Number', value: dice[winningNumber], inline: true },
      { name: '📊 Result', value: won
          ? `Matched! +**${payout} coins**`
          : `No match. -**${game.bet} coins**`, inline: false },
      { name: '💰 New Balance', value: `${userData.balance} coins`, inline: true },
      { name: '📈 Record', value: `${userData.wins}W / ${userData.losses}L`, inline: true },
    )
    .setTimestamp();
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('🎲 /roll to gamble!');
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  const db = loadDB();

  if (interaction.isChatInputCommand()) {
    const { commandName, user } = interaction;
    const userData = getUser(db, user.id);

    if (commandName === 'balance') {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`💰 ${user.username}'s Balance`)
          .setColor(0xf1c40f)
          .addFields(
            { name: 'Coins', value: `${userData.balance}`, inline: true },
            { name: 'Wins', value: `${userData.wins}`, inline: true },
            { name: 'Losses', value: `${userData.losses}`, inline: true },
          )
          .setThumbnail(user.displayAvatarURL())
        ]
      });
    }

    if (commandName === 'daily') {
      const now = Date.now();
      const cooldown = 24 * 60 * 60 * 1000;
      if (now - (userData.lastDaily || 0) < cooldown) {
        const hrs = Math.ceil((cooldown - (now - userData.lastDaily)) / 3600000);
        return interaction.reply({ content: `⏳ Come back in **${hrs}h** for your daily!`, ephemeral: true });
      }
      userData.balance += 200;
      userData.lastDaily = now;
      saveDB(db);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🎁 Daily Claimed!')
          .setColor(0x2ecc71)
          .setDescription(`+**200 coins**! New balance: **${userData.balance}**`)
        ]
      });
    }

    if (commandName === 'give') {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      if (target.id === user.id) return interaction.reply({ content: "Can't give yourself coins!", ephemeral: true });
      if (userData.balance < amount) return interaction.reply({ content: `❌ Only have **${userData.balance} coins**.`, ephemeral: true });
      const targetData = getUser(db, target.id);
      userData.balance -= amount;
      targetData.balance += amount;
      saveDB(db);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle('🤝 Transfer Complete')
          .setColor(0x3498db)
          .setDescription(`**${user.username}** → **${target.username}**: **${amount} coins**`)
        ]
      });
    }

    if (commandName === 'leaderboard') {
      const sorted = Object.entries(db).sort((a, b) => b[1].balance - a[1].balance).slice(0, 10);
      const medals = ['🥇', '🥈', '🥉'];
      const lines = await Promise.all(sorted.map(async ([id, data], i) => {
        let name;
        try { name = (await client.users.fetch(id)).username; } catch { name = 'Unknown'; }
        return `${medals[i] || `**${i + 1}.**`} **${name}** — ${data.balance} coins`;
      }));
      return interaction.reply({
        embeds: [new EmbedBuilder().setTitle('🏆 Leaderboard').setColor(0xf1c40f).setDescription(lines.join('\n'))]
      });
    }

    if (commandName === 'roll') {
      const bet = interaction.options.getInteger('bet');
      const now = Date.now();
      if (now - (userData.lastBet || 0) < BET_COOLDOWN_MS) {
        const sec = Math.ceil((BET_COOLDOWN_MS - (now - userData.lastBet)) / 1000);
        return interaction.reply({ content: `⏳ Wait **${sec}s** before betting again.`, ephemeral: true });
      }
      if (userData.balance < bet) return interaction.reply({ content: `❌ Need **${bet}** but have **${userData.balance}**.`, ephemeral: true });
      if (activeGames.has(user.id)) return interaction.reply({ content: '⚠️ Finish your current game first!', ephemeral: true });

      activeGames.set(user.id, { bet, picks: [] });

      const embed = new EmbedBuilder()
        .setTitle('🎲 Number Roll — Pick 3 Numbers!')
        .setColor(0x9b59b6)
        .setDescription(`Bet: **${bet} coins**\n\nPick **3 numbers** from 1–6.\nIf the winning number matches any pick, you win!\n\n**Picks remaining: 3**`)
        .setFooter({ text: 'Game expires in 60 seconds' });

      await interaction.reply({ embeds: [embed], components: buildPickerButtons([]) });

      setTimeout(async () => {
        if (activeGames.has(user.id)) {
          activeGames.delete(user.id);
          try { await interaction.editReply({ content: '⏰ Game expired! Use `/roll` to start again.', embeds: [], components: [] }); } catch {}
        }
      }, 60_000);
    }
  }

  if (interaction.isButton()) {
    const { user, customId } = interaction;
    if (!customId.startsWith('pick_')) return;

    const game = activeGames.get(user.id);
    if (!game) return interaction.reply({ content: '❌ No active game. Use `/roll`.', ephemeral: true });

    const pickedNumber = parseInt(customId.split('_')[1]);
    if (game.picks.includes(pickedNumber)) return;

    game.picks.push(pickedNumber);

    if (game.picks.length < 3) {
      const remaining = 3 - game.picks.length;
      const embed = new EmbedBuilder()
        .setTitle('🎲 Number Roll — Pick 3 Numbers!')
        .setColor(0x9b59b6)
        .setDescription(`Bet: **${game.bet} coins**\n\nPicked: **${game.picks.join(', ')}**\n\n**Picks remaining: ${remaining}**`)
        .setFooter({ text: 'Game expires in 60 seconds' });
      return interaction.update({ embeds: [embed], components: buildPickerButtons(game.picks) });
    }

    activeGames.delete(user.id);
    const winningNumber = Math.floor(Math.random() * 6) + 1;
    const won = game.picks.includes(winningNumber);
    const payout = Math.floor(game.bet * 1.8);

    const userData = getUser(db, user.id);
    if (won) { userData.balance += payout; userData.wins++; }
    else { userData.balance -= game.bet; userData.losses++; }
    userData.lastBet = Date.now();
    saveDB(db);

    return interaction.update({ embeds: [buildResultEmbed(userData, game, winningNumber, won, payout)], components: [] });
  }
});

client.login(TOKEN);
