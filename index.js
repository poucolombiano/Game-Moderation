// =====================================================
// ModBot: puente entre Roblox y Discord
// =====================================================
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  escapeMarkdown,
} = require("discord.js");

const {
  DISCORD_TOKEN,
  ROBLOX_API_KEY,
  ROBLOX_UNIVERSE_ID,
  SHARED_SECRET,
  CANAL_SOLICITUDES,
  CANAL_REGISTRO,
} = process.env;

const ROLES = (process.env.ROLES_APROBADORES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const [nombre, valor] of Object.entries({
  DISCORD_TOKEN,
  ROBLOX_API_KEY,
  ROBLOX_UNIVERSE_ID,
  CANAL_SOLICITUDES,
  CANAL_REGISTRO,
})) {
  if (!valor) {
    console.error(`Falta la variable de entorno ${nombre}`);
    process.exit(1);
  }
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const PERM_BAN_STORE = "PermBans_v1";
const TOPIC = "ModAction";

const CANAL_ACCIONES = process.env.CANAL_ACCIONES || "1560847732753702973";
const ROL_REVISION = process.env.ROL_REVISION || "1460341508577427732";
const CANAL_CHAT = process.env.CANAL_CHAT || "1560851695565672458";

// ─────────────────────────────────────────────────────
// Roblox (Open Cloud)
// ─────────────────────────────────────────────────────
async function guardarBan(userId, datos) {
  const url =
    `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}` +
    `/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${PERM_BAN_STORE}&entryKey=${userId}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(datos),
  });
  if (!r.ok) throw new Error(`DataStore ${r.status}: ${await r.text()}`);
}

async function avisarJuego(datos) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${TOPIC}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ message: JSON.stringify(datos) }),
  });
  if (!r.ok) throw new Error(`Messaging ${r.status}: ${await r.text()}`);
}

async function avatarDe(userId) {
  try {
    const r = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
    );
    const j = await r.json();
    return j.data?.[0]?.imageUrl || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────
// Discord
// ─────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function canal(id) {
  return client.channels.fetch(id);
}

async function enviarRegistro({ titulo, color, userId, username, reason, admin }) {
  const embed = new EmbedBuilder()
    .setTitle(titulo)
    .setColor(color)
    .setDescription(`**${username}** (${userId})`)
    .addFields(
      { name: "Reason", value: reason || "N/A" },
      { name: "Administrator", value: admin }
    )
    .setTimestamp();
  const avatar = await avatarDe(userId);
  if (avatar) embed.setThumbnail(avatar);
  const ch = await canal(CANAL_REGISTRO);
  await ch.send({ embeds: [embed] });
}

function campo(embed, nombre) {
  return embed.fields.find((f) => f.name === nombre)?.value || "N/A";
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "reviewed") {
    const puede = interaction.member?.roles?.cache?.some(
      (r) => r.id === ROL_REVISION || ROLES.includes(r.id)
    );
    if (!puede) {
      return interaction.reply({
        content: "You do not have permission to review this.",
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferUpdate();
    const hecho = new ButtonBuilder()
      .setCustomId("reviewed_done")
      .setLabel(`Reviewed by ${interaction.user.username} (${interaction.user.id})`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(true);
    await interaction.editReply({ components: [new ActionRowBuilder().addComponents(hecho)] });
    return;
  }

  const [accion, userId] = interaction.customId.split(":");
  if (accion !== "approve" && accion !== "deny") return;

  const permitido = interaction.member?.roles?.cache?.some((r) => ROLES.includes(r.id));
  if (!permitido) {
    return interaction.reply({
      content: "You do not have permission to approve or reject requests.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  const original = interaction.message.embeds[0];
  const username = campo(original, "Username");
  const reason = campo(original, "Reason");
  const requestedBy = campo(original, "Requested by");

  try {
    if (accion === "approve") {
      await guardarBan(userId, {
        reason,
        bannedBy: requestedBy,
        approvedBy: interaction.user.tag,
      });
      try {
        await avisarJuego({ action: "ban", userId: Number(userId), reason });
      } catch (e) {
        console.error("No se pudo avisar al juego (el ban sí quedó guardado):", e.message);
      }

      const editado = EmbedBuilder.from(original)
        .setColor(0xFFFFFF)
        .setTitle("Request Ban: APPROVED")
        .addFields({ name: "Approved by", value: `<@${interaction.user.id}> (${interaction.user.id})` });
      await interaction.editReply({ embeds: [editado], components: [] });

      await enviarRegistro({
        titulo: "User Banned.",
        color: 0xFFFFFF,
        userId,
        username,
        reason,
        admin: `<@${interaction.user.id}> (${interaction.user.id})`,
      });
    } else {
      const editado = EmbedBuilder.from(original)
        .setColor(0xFFFFFF)
        .setTitle("Request Ban: REJECTED")
        .addFields({ name: "Rejected by", value: `<@${interaction.user.id}> (${interaction.user.id})` });
      await interaction.editReply({ embeds: [editado], components: [] });
    }
  } catch (e) {
    console.error(e);
    await interaction.followUp({
      content: "An error occurred: " + e.message,
      flags: MessageFlags.Ephemeral,
    });
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ [Discord] Bot conectado como ${client.user.tag}`);
  const canales = { CANAL_SOLICITUDES, CANAL_REGISTRO, CANAL_ACCIONES, CANAL_CHAT };
  for (const [nombre, id] of Object.entries(canales)) {
    try {
      const ch = await client.channels.fetch(id);
      const puede = ch?.permissionsFor?.(client.user)?.has(["ViewChannel", "SendMessages"]);
      console.log(
        `[Check] Canal ${nombre} (${id}) -> #${ch?.name} ${puede ? "OK" : "SIN PERMISO de Ver/Enviar mensajes"}`
      );
    } catch (e) {
      console.log(`[Check] Canal ${nombre} (${id}) -> FALLO: ${e.message}`);
    }
  }
});

client.on(Events.Error, (e) => console.error("[Discord error]", e));
client.on(Events.ShardError, (e) => console.error("[Discord shard error]", e));
client.on(Events.Warn, (msg) => console.warn("[Discord warn]", msg));

// ─────────────────────────────────────────────────────
// Servidor web (lo llama Roblox)
// ─────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("ModBot activo"));

app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} desde ${req.get("x-forwarded-for") || req.ip}`);
  next();
});

app.use((req, res, next) => {
  if (SHARED_SECRET && req.get("x-secret") !== SHARED_SECRET) {
    console.log(`[HTTP] 401 en ${req.path}: x-secret no coincide con SHARED_SECRET`);
    return res.status(401).json({ error: "no autorizado" });
  }
  next();
});

app.post("/requestban", async (req, res) => {
  try {
    const { username, reason, requestedBy, requestedById } = req.body;
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId) || !username) return res.status(400).json({ error: "datos inválidos" });

    const embed = new EmbedBuilder()
      .setTitle("Request Ban")
      .setColor(0xFFFFFF)
      .addFields(
        { name: "Username", value: String(username), inline: true },
        { name: "UserID", value: String(userId), inline: true },
        { name: "Reason", value: String(reason || "N/A").slice(0, 1000) },
        { name: "Requested by", value: `${requestedBy || "?"} (${requestedById || "?"})`, inline: true }
      )
      .setTimestamp();
    const avatar = await avatarDe(userId);
    if (avatar) embed.setThumbnail(avatar);

    const botones = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`approve:${userId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`deny:${userId}`).setLabel("Disapprove").setStyle(ButtonStyle.Danger)
    );

    const ch = await canal(CANAL_SOLICITUDES);
    await ch.send({
      content: ROLES.map((id) => `<@&${id}>`).join(" ") || undefined,
      embeds: [embed],
      components: [botones],
      allowedMentions: { roles: ROLES },
    });
    console.log(`[requestban] enviado a Discord: ${username} (${userId})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[requestban] ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/log", async (req, res) => {
  try {
    const { type, username, reason, admin, adminId } = req.body;
    const userId = Number(req.body.userId);
    if (type !== "ban" && type !== "unban") return res.status(400).json({ error: "tipo inválido" });
    await enviarRegistro({
      titulo: type === "ban" ? "User Banned." : "User UnBanned.",
      color: 0xFFFFFF,
      userId,
      username,
      reason: reason || "N/A",
      admin: `${admin || "?"} (${adminId || "?"}) [in-game]`,
    });
    console.log(`[log] ${type}: ${username} (${userId})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[log] ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/action", async (req, res) => {
  try {
    const { type, username, reason, moderator, moderatorId } = req.body;
    const userId = Number(req.body.userId);
    const titulos = { kick: "Kick", serverban: "Server Ban", unserverban: "Server Unban", unban: "Unban", tp: "Teleport" };
    if (!titulos[type] || !Number.isInteger(userId)) return res.status(400).json({ error: "datos inválidos" });

    const embed = new EmbedBuilder()
      .setTitle(titulos[type])
      .setColor(0xFFFFFF)
      .setDescription(`**${username}** (${userId})`)
      .addFields({ name: "Moderator", value: 
                  
