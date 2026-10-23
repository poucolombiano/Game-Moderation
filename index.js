// =====================================================
// ModBot: puente entre Roblox y Discord
// Roblox -> /requestban -> mensaje con botones -> aprobar -> ban en Roblox
// =====================================================
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

const PERM_BAN_STORE = "PermBans_v1"; // el mismo nombre que usa tu script de Roblox
const TOPIC = "ModAction"; // el mismo topic que escucha tu script de Roblox

// Canal de acciones de moderación (/kick /serverban /tp) y rol que lo revisa
const CANAL_ACCIONES = process.env.CANAL_ACCIONES || "1560847732753702973";
const ROL_REVISION = process.env.ROL_REVISION || "1460341508577427732";

// Canal donde se registra el chat del juego
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  // Botón "Reviewed" de los registros de acciones (/kick /serverban /tp)
  if (interaction.customId === "reviewed") {
    const puede = interaction.member?.roles?.cache?.some(
      (r) => r.id === ROL_REVISION || ROLES.includes(r.id)
    );
    if (!puede) {
      return interaction.reply({
        content: "You do not have permission to review this.",
        ephemeral: true,
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

  // Solo los roles autorizados pueden pulsar
  const permitido = interaction.member?.roles?.cache?.some((r) => ROLES.includes(r.id));
  if (!permitido) {
    return interaction.reply({
      content: "You do not have permission to approve or reject requests.",
      ephemeral: true,
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
      // Si el jugador está conectado, que lo expulsen ya
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
      ephemeral: true,
    });
  }
});

client.once("ready", () => console.log(`Bot conectado como ${client.user.tag}`));

// ─────────────────────────────────────────────────────
// Servidor web (lo llama Roblox)
// ─────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Página de salud: sirve para que un monitor la visite y el bot no se duerma
app.get("/", (_req, res) => res.send("ModBot activo"));

// La contraseña secreta es OPCIONAL: solo se exige si pones SHARED_SECRET en las variables
app.use((req, res, next) => {
  if (SHARED_SECRET && req.get("x-secret") !== SHARED_SECRET) {
    return res.status(401).json({ error: "no autorizado" });
  }
  next();
});

app.post("/requestban", async (req, res) => {
  try {
    const { userId, username, reason, requestedBy, requestedById } = req.body;
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
      content: ROLES.map((id) => `<@&${id}>`).join(" "),
      embeds: [embed],
      components: [botones],
      allowedMentions: { roles: ROLES },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Para registrar /ban y /unban hechos dentro del juego
app.post("/log", async (req, res) => {
  try {
    const { type, userId, username, reason, admin, adminId } = req.body;
    if (type !== "ban" && type !== "unban") return res.status(400).json({ error: "tipo inválido" });
    await enviarRegistro({
      titulo: type === "ban" ? "User Banned." : "User UnBanned.",
      color: type === "ban" ? 0xFFFFFF : 0xFFFFFF,
      userId,
      username,
      reason: reason || "N/A",
      admin: `${admin || "?"} (${adminId || "?"}) [in-game]`,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Registro de acciones: /kick /serverban /tp
app.post("/action", async (req, res) => {
  try {
    const { type, userId, username, reason, moderator, moderatorId } = req.body;
    const titulos = { kick: "Kick", serverban: "Server Ban", unserverban: "Server Unban", unban: "Unban", tp: "Teleport" };
    if (!titulos[type] || !Number.isInteger(userId)) return res.status(400).json({ error: "datos inválidos" });

    const embed = new EmbedBuilder()
      .setTitle(titulos[type])
      .setColor(0xFFFFFF)
      .setDescription(`**${username}** (${userId})`)
      .addFields({ name: "Moderator", value: `${moderator || "?"} (${moderatorId || "?"})` })
      .setTimestamp();
    if (type !== "tp" && type !== "unserverban") embed.addFields({ name: "Reason", value: String(reason || "N/A").slice(0, 1000) });
    const avatar = await avatarDe(userId);
    if (avatar) embed.setThumbnail(avatar);

    const mensaje = { embeds: [embed] };
    // Los /tp se registran sin etiquetar roles y sin botón; el resto sí
    if (type !== "tp") {
      mensaje.content = `<@&${ROL_REVISION}>`;
      mensaje.components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("reviewed").setLabel("Reviewed").setStyle(ButtonStyle.Success)
        ),
      ];
      mensaje.allowedMentions = { roles: [ROL_REVISION] };
    }
    const ch = await canal(CANAL_ACCIONES);
    await ch.send(mensaje);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Registro del chat del juego (llega en lotes desde Roblox)
app.post("/chat", async (req, res) => {
  try {
    const lista = Array.isArray(req.body.messages) ? req.body.messages.slice(0, 100) : [];
    if (!lista.length) return res.json({ ok: true });

    const lineas = lista.map(
      (m) =>
        `**${escapeMarkdown(String(m.name || "?"))}** (${m.userId}) [Rank ${m.rank}]: ` +
        escapeMarkdown(String(m.text || "").slice(0, 200))
    );

    // Agrupar en bloques de menos de 3800 caracteres (un embed por mensaje)
    const bloques = [];
    let bloque = "";
    for (const l of lineas) {
      if (bloque && (bloque + "\n" + l).length > 3800) {
        bloques.push(bloque);
        bloque = l;
      } else {
        bloque = bloque ? bloque + "\n" + l : l;
      }
    }
    if (bloque) bloques.push(bloque);

    const ch = await canal(CANAL_CHAT);
    for (const b of bloques) {
      await ch.send({
        embeds: [new EmbedBuilder().setColor(0xFFFFFF).setDescription(b)],
        allowedMentions: { parse: [] },
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Servidor web listo"));
// Autodiagnóstico al arrancar: prueba los permisos de la API key y lo deja escrito en los Logs
async function autoPrueba() {
  const U = ROBLOX_UNIVERSE_ID;
  const headers = { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" };
  console.log(
    `[Check] Universe ID: ${U} | key length: ${ROBLOX_API_KEY.length} | key ends with: ...${ROBLOX_API_KEY.slice(-4)}`
  );
  try {
    const url =
      `https://apis.roblox.com/datastores/v1/universes/${U}/standard-datastores/datastore/entries/entry` +
      `?datastoreName=${PERM_BAN_STORE}&entryKey=__healthcheck__`;
    const w = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ok: true }) });
    console.log(`[Check] DataStore WRITE -> ${w.status} ${w.ok ? "OK" : await w.text()}`);
    if (w.ok) {
      const d = await fetch(url, { method: "DELETE", headers });
      console.log(`[Check] DataStore DELETE -> ${d.status}`);
    }
  } catch (e) {
    console.log("[Check] DataStore error:", e.message);
  }
  try {
    const m = await fetch(
      `https://apis.roblox.com/messaging-service/v1/universes/${U}/topics/ModBotHealth`,
      { method: "POST", headers, body: JSON.stringify({ message: "check" }) }
    );
    console.log(`[Check] Messaging PUBLISH -> ${m.status} ${m.ok ? "OK" : await m.text()}`);
  } catch (e) {
    console.log("[Check] Messaging error:", e.message);
  }
}

client.login(DISCORD_TOKEN);
autoPrueba();
