const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || "YOUR_DISCORD_BOT_TOKEN_HERE",
    CLIENT_ID: process.env.CLIENT_ID || "YOUR_CLIENT_ID_HERE",
    PORT: process.env.PORT || 3000,
    
    // Replace with your Discord server's Role IDs
    ROLES: {
        OWNER_ROLE_ID: {
            name: "Owner",
            allowedDurations: ["1d", "7d", "30d", "lifetime"]
        },
        ADMIN_ROLE_ID: {
            name: "Admin",
            allowedDurations: ["1d", "7d", "30d"]
        },
        RESELLER_ROLE_ID: {
            name: "Reseller",
            allowedDurations: ["1d", "7d"]
        }
    }
};

// ==========================================
// DATABASE (JSON FILE BASED)
// ==========================================
const DB_FILE = path.join(__dirname, 'keys.json');

function loadKeys() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({}));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveKeys(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Master Key Default Setup
let keysDb = loadKeys();
if (!keysDb["owner"]) {
    keysDb["owner"] = {
        key: "owner",
        createdBy: "SYSTEM",
        duration: "lifetime",
        expiresAt: null,
        maxUses: 999999,
        usedCount: 0,
        active: true
    };
    saveKeys(keysDb);
}

// ==========================================
// EXPRESS WEB SERVER (ROBLOX API)
// ==========================================
const app = express();
app.use(express.json());
app.use(cors());

// Roblox Key Verification Endpoint
app.post('/api/verify', (req, res) => {
    const { key } = req.body;
    
    if (!key) {
        return res.json({ valid: false, message: "No key provided" });
    }

    keysDb = loadKeys();
    const record = keysDb[key];

    if (!record || !record.active) {
        return res.json({ valid: false, message: "INVALID KEY!" });
    }

    // Check expiration
    if (record.expiresAt && new Date() > new Date(record.expiresAt)) {
        record.active = false;
        saveKeys(keysDb);
        return res.json({ valid: false, message: "KEY EXPIRED!" });
    }

    // Check max uses
    if (record.usedCount >= record.maxUses) {
        return res.json({ valid: false, message: "MAX USES REACHED!" });
    }

    // Increment use count
    record.usedCount += 1;
    saveKeys(keysDb);

    return res.json({ valid: true, message: "ACCESS GRANTED" });
});

app.get('/', (req, res) => {
    res.send("Milky Hub Key Server Active");
});

app.listen(CONFIG.PORT, () => {
    console.log(`[API] Server online on port ${CONFIG.PORT}`);
});

// ==========================================
// DISCORD BOT
// ==========================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('genkey')
        .setDescription('Generate a Milky Hub premium key')
        .addStringOption(option =>
            option.setName('duration')
                .setDescription('Key valid duration')
                .setRequired(true)
                .addChoices(
                    { name: '1 Day', value: '1d' },
                    { name: '7 Days', value: '7d' },
                    { name: '30 Days', value: '30d' },
                    { name: 'Lifetime', value: 'lifetime' }
                ))
        .addIntegerOption(option =>
            option.setName('max_uses')
                .setDescription('Maximum key uses (default 1)')
                .setRequired(false)),
    new SlashCommandBuilder()
        .setName('revokekey')
        .setDescription('Revoke an existing key')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('The key string to disable')
                .setRequired(true))
];

// Register Commands
const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
(async () => {
    try {
        console.log('[BOT] Registering commands...');
        await rest.put(
            Routes.applicationCommands(CONFIG.CLIENT_ID),
            { body: commands }
        );
        console.log('[BOT] Commands registered!');
    } catch (error) {
        console.error('[BOT] Command error:', error);
    }
})();

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, member } = interaction;

    // Check Role Permissions
    let userPermissions = null;
    for (const [roleId, perm] of Object.entries(CONFIG.ROLES)) {
        if (member.roles.cache.has(roleId)) {
            userPermissions = perm;
            break;
        }
    }

    if (!userPermissions) {
        return interaction.reply({ content: '❌ You do not have permissions to use key management commands.', ephemeral: true });
    }

    if (commandName === 'genkey') {
        const duration = interaction.options.getString('duration');
        const maxUses = interaction.options.getInteger('max_uses') || 1;

        if (!userPermissions.allowedDurations.includes(duration)) {
            return interaction.reply({ content: `❌ Your role level (**${userPermissions.name}**) cannot create **${duration}** keys.`, ephemeral: true });
        }

        const rawCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        const generatedKey = `MILKY-${duration.toUpperCase()}-${rawCode}`;

        let expiresAt = null;
        const now = new Date();
        if (duration === '1d') expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        if (duration === '7d') expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        if (duration === '30d') expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        keysDb = loadKeys();
        keysDb[generatedKey] = {
            key: generatedKey,
            createdBy: interaction.user.id,
            duration: duration,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            maxUses: maxUses,
            usedCount: 0,
            active: true
        };
        saveKeys(keysDb);

        const embed = new EmbedBuilder()
            .setTitle('🌸 Milky Hub Key Generated')
            .setColor(0xFFB4D2)
            .addFields(
                { name: 'Key', value: `\`\`\`${generatedKey}\`\`\`` },
                { name: 'Duration', value: duration, inline: true },
                { name: 'Max Uses', value: `${maxUses}`, inline: true },
                { name: 'Created By', value: `<@${interaction.user.id}>`, inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'revokekey') {
        const targetKey = interaction.options.getString('key');
        keysDb = loadKeys();

        if (!keysDb[targetKey]) {
            return interaction.reply({ content: '❌ Key not found.', ephemeral: true });
        }

        keysDb[targetKey].active = false;
        saveKeys(keysDb);

        return interaction.reply({ content: `✅ Key \`${targetKey}\` has been revoked.`, ephemeral: true });
    }
});

client.login(CONFIG.DISCORD_TOKEN);
