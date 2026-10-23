// =====================================================
// ModBot: puente entre Roblox y Discord  -- VERSIÓN CORREGIDA
// Roblox -> /requestban -> mensaje con botones -> aprobar -> ban en Roblox
//
// Cambios respecto a la versión anterior:
//   - Registra en los Logs de Render CADA petición que llega desde Roblox
//   - Al arrancar comprueba que el bot ve cada canal y escribe OK/FALLO con el motivo
//   - El servidor web arranca primero (Render lo detecta aunque Discord tarde en conectar)
//   - Errores globales capturados: el bot no se cae por una promesa rechazada
//   - Se mantiene despierto a sí mismo usando RENDER_EXTERNAL_URL (automática en Render)
//   - userId acepta número o texto numérico
//   - NUEVO: diagnóstico extra al conectar con Discord (para detectar logins "colgados")
//   - NUEVO: logs de debug SIN FILTRAR para ver exactamente dónde se atasca la conexión
// =====================================================
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

// Que un error suelto no tumbe el bot
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  // Botón "Reviewed" de los registros de acciones (/kick /serverban /tp)
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

  // Solo los roles autorizados pueden pulsar
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
      flags: MessageFlags.Ephemeral,
    });
  }
});

// Al conectar: comprueba que el bot puede ver y escribir en cada canal
client.once(Events.ClientReady, async () => {
  console.log(`✅ [Discord] Bot conectado como ${client.user.tag}`);
  const canales = {
    CANAL_SOLICITUDES,
    CANAL_REGISTRO,
    CANAL_ACCIONES,
    CANAL_CHAT,
  };
  for (const [nombre, id] of Object.entries(canales)) {
    try {
      const ch = await client.channels.fetch(id);
      const puede = ch?.permissionsFor?.(client.user)?.has(["ViewChannel", "SendMessages"]);
      console.log(
        `[Check] Canal ${nombre} (${id}) -> #${ch?.name} ${puede ? "OK" : "SIN PERMISO de Ver/Enviar mensajes"}`
      );
    } catch (e) {
      console.log(`[Check] Canal ${nombre} (${id}) -> FALLO: ${e.message} (ID incorrecto o el bot no está en ese servidor/canal)`);
    }
  }
});

client.on(Events.Error, (e) => console.error("[Discord error]", e));
client.on(Events.ShardError, (e) => console.error("[Discord shard error]", e));
client.on(Events.Warn, (msg) => console.warn("[Discord warn]", msg));
client.on(Events.Invalidated, () => console.error("[Discord] Sesión invalidada."));
client.on(Events.Debug, (msg) => {
  console.log("[Discord debug]", msg);
});

// ─────────────────────────────────────────────────────
// Servidor web (lo llama Roblox)
// ─────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

// Página de salud: sirve para que un monitor la visite y el bot no se duerma
app.get("/", (_req, res) => res.send("ModBot activo"));

// Registra en los Logs de Render cada petición que llega
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} desde ${req.get("x-forwarded-for") || req.ip}`);
  next();
});

// La contraseña secreta es OPCIONAL: solo se exige si pones SHARED_SECRET en las variables
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

// Para registrar /ban y /unban hechos dentro del juego
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

// Registro de acciones: /kick /serverban /tp
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
    console.log(`[action] ${type}: ${username} (${userId})`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[action] ERROR:", e);
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
    console.log(`[chat] ${lista.length} mensaje(s) enviados a Discord`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[chat] ERROR:", e);
    res.status(500).json({ error: e.message });
  }
});

// El servidor web arranca ANTES de conectar con Discord
app.listen(process.env.PORT || 3000, () => console.log("Servidor web listo"));

// Se "toca" a sí mismo cada 10 min para que Render no lo duerma (solo funciona mientras esté despierto;
// para despertarlo desde cero sigue siendo útil UptimeRobot o el ping que ya hace el script de Roblox)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

// ─────────────────────────────────────────────────────
// Autodiagnóstico al arrancar: prueba los permisos de la API key y lo deja escrito en los Logs
// ─────────────────────────────────────────────────────
async function autoPrueba() {
  const U = ROBLOX_UNIVERSE_ID;
  const headers = { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" };
  console.log(
    `[Check] Universe ID: ${U} | key length: ${ROBLOX_API_KEY.length} | key ends with: ...${ROBLOX_API_KEY.slice(-4)}`
  );
  console.log(`[Check] SHARED_SECRET ${SHARED_SECRET ? "ACTIVADO (Roblox debe enviar el mismo x-secret)" : "no activado"}`);
  console.log(`[Check] Roles aprobadores configurados: ${ROLES.length}`);
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

// ─────────────────────────────────────────────────────
// Conexión con Discord (con diagnóstico extra)
// ─────────────────────────────────────────────────────
console.log("[Discord] Intentando conectar... longitud del token:", (DISCORD_TOKEN || "").length);
console.log("[Discord] El token tiene formato de 3 partes separadas por puntos:", DISCORD_TOKEN.split(".").length === 3);

client.login(DISCORD_TOKEN)
  .then(() => {
    console.log("[Discord] login() terminó SIN errores (esto no significa que ya esté listo, solo que se envió la solicitud).");
  })
  .catch((e) => {
    console.error("[Discord] ❌ NO SE PUDO INICIAR SESIÓN. Motivo:", e.message);
    console.error("[Discord] Código de error:", e.code || "sin código");
  });

setTimeout(() => {
  if (!client.isReady()) {
    console.warn("[Discord] ⚠️ ADVERTENCIA: pasaron 45 segundos y el bot NO está listo (client.isReady() = false).");
    console.warn("[Discord] Esto puede significar: token inválido de forma no estándar, bloqueo de red/firewall en Render hacia Discord, o la app de Discord fue eliminada/deshabilitada.");
  } else {
    console.log("[Discord] (45s después) client.isReady() = true, todo en orden.");
  }
}, 45000);

autoPrueba();
