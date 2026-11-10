// =====================================================
// ModBot: puente entre Roblox y Discord
// Roblox -> /requestban -> mensaje con botones -> aprobar -> ban en Roblox
// Discord -> /requestban Username Reason -> mismo mensaje con botones
// + /modlist: mensajes por semana de los usuarios con los roles de staff
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

// Rol que se etiqueta con /level /slot /tp all /tp user user /shutdown
const ROL_ALERTA = process.env.ROL_ALERTA || "1562872203928670228";

// Canal donde se registra el chat del juego
const CANAL_CHAT = process.env.CANAL_CHAT || "1560851695565672458";

// Roles cuyos mensajes se cuentan para /modlist (en este orden se muestran)
const ROLES_STAFF = ["1460341572703883408", "1557087788845899807"];

// Roles que pueden usar /requestban desde Discord
const ROLES_REQUESTBAN = [
  "1562872203928670228",
  "1460341508577427732",
  "1460341572703883408",
  "1557087788845899807",
];

// DataStore (Roblox) donde se guardan los conteos, así no se pierden al reiniciar Render
const STATS_STORE = "ModStats_v1";
const STATS_KEY = "stats";

// Las semanas van de lunes a domingo, en hora de Colombia (UTC-5)
const OFFSET_HORAS = -5;

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

// Convierte un username de Roblox en { id, name } (o null si no existe)
async function buscarUsuarioRoblox(username) {
  const r = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  if (!r.ok) throw new Error(`Roblox Users ${r.status}`);
  const j = await r.json();
  const u = j.data?.[0];
  return u ? { id: u.id, name: u.name } : null;
}

// ─────────────────────────────────────────────────────
// Conteo de mensajes por semana (/modlist)
// datos = { "2026-11-09": { "userId": cantidad } }  (la clave es el lunes de esa semana)
// ─────────────────────────────────────────────────────
const URL_STATS =
  `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}` +
  `/standard-datastores/datastore/entries/entry` +
  `?datastoreName=${STATS_STORE}&entryKey=${STATS_KEY}`;

let datos = {};
let cargado = false;
let sucio = false;

function inicioSemana(ts) {
  const d = new Date(ts + OFFSET_HORAS * 3600 * 1000);
  const diff = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function sumar(a, b) {
  const res = {};
  for (const fuente of [a, b]) {
    for (const [semana, usuarios] of Object.entries(fuente || {})) {
      res[semana] = res[semana] || {};
      for (const [id, n] of Object.entries(usuarios)) {
        res[semana][id] = (res[semana][id] || 0) + n;
      }
    }
  }
  return res;
}

function limpiarViejas() {
  const limite = inicioSemana(Date.now() - 21 * 24 * 3600 * 1000);
  for (const semana of Object.keys(datos)) {
    if (semana < limite) delete datos[semana];
  }
}

async function cargarStats() {
  const r = await fetch(URL_STATS, { headers: { "x-api-key": ROBLOX_API_KEY } });
  if (r.status === 404) return {}; // todavía no existe: empezamos de cero
  if (!r.ok) throw new Error(`DataStore ${r.status}: ${await r.text()}`);
  return await r.json();
}

async function intentarCargar() {
  if (cargado) return;
  try {
    const guardado = await cargarStats();
    datos = sumar(guardado, datos); // suma lo que se contó mientras no se pudo cargar
    cargado = true;
    sucio = true;
    console.log("[Stats] Conteos cargados.");
  } catch (e) {
    console.error("[Stats] No se pudieron cargar los conteos (se reintenta):", e.message);
  }
}

async function guardarStats() {
  if (!cargado || !sucio) return;
  sucio = false;
  limpiarViejas();
  try {
    const r = await fetch(URL_STATS, {
      method: "POST",
      headers: { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(datos),
    });
    if (!r.ok) throw new Error(`DataStore ${r.status}: ${await r.text()}`);
  } catch (e) {
    sucio = true;
    console.error("[Stats] No se pudieron guardar los conteos:", e.message);
  }
}

function contarMensaje(userId) {
  const semana = inicioSemana(Date.now());
  datos[semana] = datos[semana] || {};
  datos[semana][userId] = (datos[semana][userId] || 0) + 1;
  sucio = true;
}

intentarCargar();
setInterval(async () => {
  await intentarCargar();
  await guardarStats();
}, 60 * 1000);

process.on("SIGTERM", async () => {
  await guardarStats();
  process.exit(0);
});

// ─────────────────────────────────────────────────────
// Discord
// ─────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // para listar a los usuarios de cada rol
    GatewayIntentBits.GuildMessages, // para contar mensajes
  ],
});

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

// Publica la solicitud de ban con botones (la usan el juego y el comando de Discord)
async function enviarSolicitudBan({ userId, username, reason, requestedBy, requestedById }) {
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
}

function campo(embed, nombre) {
  return embed.fields.find((f) => f.name === nombre)?.value || "N/A";
}

// Cuenta TODOS los mensajes (texto, stickers, gifs, fotos, tickets...) de usuarios con los roles de staff
client.on("messageCreate", (m) => {
  if (!m.guild || m.author.bot || m.webhookId || m.system) return;
  const roles = m.member?.roles?.cache;
  if (!roles) return;
  if (!ROLES_STAFF.some((id) => roles.has(id))) return;
  contarMensaje(m.author.id);
});

function construirEmbeds(titulo, lineas) {
  const textos = [];
  let desc = `# ${titulo} MESSAGES\n\n`;
  if (!lineas.length) desc += "Sin usuarios con este rol.\n";
  for (const l of lineas) {
    if ((desc + l).length > 3800) {
      textos.push(desc);
      desc = "";
    }
    desc += l + "\n\n";
  }
  textos.push(desc);
  return textos.map((t) => new EmbedBuilder().setColor(0xFFFFFF).setDescription(t));
}

async function comandoModList(interaction) {
  const puede = interaction.member?.roles?.cache?.some(
    (r) => r.id === ROL_REVISION || ROLES.includes(r.id)
  );
  if (!puede) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const semanaActual = inicioSemana(Date.now());
  const semanaPasada = inicioSemana(Date.now() - 7 * 24 * 3600 * 1000);
  const esta = datos[semanaActual] || {};
  const pasada = datos[semanaPasada] || {};

  await interaction.guild.members.fetch();

  const embeds = [];
  for (const rolId of ROLES_STAFF) {
    const rol = interaction.guild.roles.cache.get(rolId);
    if (!rol) continue;

    const lineas = [...rol.members.values()]
      .filter((mb) => !mb.user.bot)
      .map((mb) => ({
        tag: mb.user.tag,
        id: mb.id,
        esta: esta[mb.id] || 0,
        pasada: pasada[mb.id] || 0,
      }))
      .sort((a, b) => b.esta - a.esta || b.pasada - a.pasada)
      .map(
        (u) =>
          `**${escapeMarkdown(u.tag)}**\nThis Week: ${u.esta}\nLast Week: ${u.pasada}`
      );

    embeds.push(...construirEmbeds(rol.name, lineas));
  }

  if (!embeds.length) {
    return interaction.editReply("No encontré ninguno de los roles en este servidor.");
  }

  embeds[embeds.length - 1].setFooter({
    text: "Semanas de lunes a domingo (hora Colombia)",
  });

  // Discord permite máximo 10 embeds por mensaje
  await interaction.editReply({ embeds: embeds.slice(0, 10) });
  for (let i = 10; i < embeds.length; i += 10) {
    await interaction.followUp({ embeds: embeds.slice(i, i + 10) });
  }
}

// /requestban Username Reason  (desde Discord)
async function comandoRequestBan(interaction) {
  const puede = interaction.member?.roles?.cache?.some((r) => ROLES_REQUESTBAN.includes(r.id));
  if (!puede) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  // Respuesta pública: el embed de confirmación se ve en el chat
  await interaction.deferReply();

  // Los errores se muestran solo a quien ejecutó el comando
  const errorPrivado = async (texto) => {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: texto, ephemeral: true });
  };

  const nombre = interaction.options.getString("username", true).trim();
  const razon = interaction.options.getString("reason", true).trim();

  let usuario;
  try {
    usuario = await buscarUsuarioRoblox(nombre);
  } catch (e) {
    return errorPrivado("No pude consultar Roblox: " + e.message);
  }
  if (!usuario) {
    return errorPrivado(`No encontré al usuario de Roblox: ${nombre}`);
  }

  await enviarSolicitudBan({
    userId: usuario.id,
    username: usuario.name,
    reason: razon,
    requestedBy: `${interaction.user.username} [Discord]`,
    requestedById: interaction.user.id,
  });

  const confirmacion = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setDescription(
      `Hey! You have requested the ban of **${escapeMarkdown(usuario.name)}**\n` +
        `We have notified an Administrator who will review the request\n` +
        `Make sure to upload the evidence to the channel: https://discord.com/channels/1442882285891489824/1492994084334207026\n` +
        `If the evidence is not there after one day, you may be demoted for administrative abuse.`
    );
  const avatar = await avatarDe(usuario.id);
  if (avatar) confirmacion.setThumbnail(avatar);

  await interaction.editReply({ embeds: [confirmacion] });
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "modlist") {
      try {
        await comandoModList(interaction);
      } catch (e) {
        console.error(e);
        const texto = "An error occurred: " + e.message;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(texto).catch(() => {});
        } else {
          await interaction.reply({ content: texto, ephemeral: true }).catch(() => {});
        }
      }
    } else if (interaction.commandName === "requestban") {
      try {
        await comandoRequestBan(interaction);
      } catch (e) {
        console.error(e);
        const texto = "An error occurred: " + e.message;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(texto).catch(() => {});
        } else {
          await interaction.reply({ content: texto, ephemeral: true }).catch(() => {});
        }
      }
    }
    return;
  }

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

client.once("ready", async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  // Registra /modlist y /requestban en cada servidor donde está el bot (aparecen al instante)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.create({
        name: "modlist",
        description: "Shows this week's and last week's message counts for users with staff roles",
      });
    } catch (e) {
      console.error(`No se pudo registrar /modlist en ${guild.name}:`, e.message);
    }
    try {
      await guild.commands.create({
        name: "requestban",
        description: "Sends a ban request for a Roblox user",
        options: [
          {
            name: "username",
            description: "Roblox username of the player",
            type: 3, // STRING
            required: true,
          },
          {
            name: "reason",
            description: "Reason for the ban",
            type: 3, // STRING
            required: true,
            max_length: 500,
          },
        ],
      });
    } catch (e) {
      console.error(`No se pudo registrar /requestban en ${guild.name}:`, e.message);
    }
  }
});

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

    await enviarSolicitudBan({ userId, username, reason, requestedBy, requestedById });
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

// Registro de acciones: /kick /serverban /tp + alertas (/level /slot /tp all /tp user user /shutdown)
app.post("/action", async (req, res) => {
  try {
    const { type, userId, username, reason, moderator, moderatorId } = req.body;
    const titulos = {
      kick: "Kick",
      serverban: "Server Ban",
      unserverban: "Server Unban",
      unban: "Unban",
      tp: "Teleport",
      level: "Level Changed",
      slot: "Slot Changed",
      tpall: "Teleport All",
      tpmove: "Teleport Player",
      shutdown: "Server Shutdown",
    };
    // Tipos que etiquetan al rol de alertas
    const alertas = new Set(["level", "slot", "tpall", "tpmove", "shutdown"]);

    if (!titulos[type] || !Number.isInteger(userId)) return res.status(400).json({ error: "datos inválidos" });

    const esAlerta = alertas.has(type);

    const embed = new EmbedBuilder()
      .setTitle(titulos[type])
      .setColor(0xFFFFFF)
      .setDescription(`**${username}** (${userId})`)
      .addFields({ name: "Moderator", value: `${moderator || "?"} (${moderatorId || "?"})` })
      .setTimestamp();
    if (esAlerta) {
      embed.addFields({ name: "Details", value: String(reason || "N/A").slice(0, 1000) });
    } else if (type !== "tp" && type !== "unserverban") {
      embed.addFields({ name: "Reason", value: String(reason || "N/A").slice(0, 1000) });
    }
    if (userId > 0) {
      const avatar = await avatarDe(userId);
      if (avatar) embed.setThumbnail(avatar);
    }

    const mensaje = { embeds: [embed] };
    if (esAlerta) {
      // Alertas: etiquetan al rol de alertas, sin botón
      mensaje.content = `<@&${ROL_ALERTA}>`;
      mensaje.allowedMentions = { roles: [ROL_ALERTA] };
    } else if (type !== "tp") {
      // Los /tp se registran sin etiquetar roles y sin botón; el resto sí
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
