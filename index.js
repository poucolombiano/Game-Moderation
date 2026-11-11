// =====================================================
// ModBot: puente entre Roblox y Discord
// Roblox -> /requestban -> mensaje con botones -> aprobar -> ban en Roblox
// Discord -> /requestban Username Reason -> mismo mensaje con botones
// + /modlist: mensajes por semana de los usuarios con los roles de staff
// + /slot, /information, /banlist (solo rol ROL_ALERTA)
// =====================================================
const express = require("express");
const crypto = require("crypto");
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
const TOPIC_CHECK = "ModCheck"; // topic para preguntar "¿este jugador está en línea?"

// Canal de acciones de moderación (/kick /serverban /tp) y rol que lo revisa
const CANAL_ACCIONES = process.env.CANAL_ACCIONES || "1560847732753702973";
const ROL_REVISION = process.env.ROL_REVISION || "1460341508577427732";

// Rol que se etiqueta con /level /slot /tp all /tp user user /shutdown
// y ÚNICO rol que puede usar /slot, /information y /banlist en Discord
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

// DataStores nuevos
const SLOTS_STORE = "SlotsMagicos_v1"; // el mismo que usa SlotsDataStore
const VERSION_DATOS_SLOTS = 4; // igual que VERSION_DATOS en SlotsDataStore
const CANTIDAD_SLOTS = 6;
const HIST_STORE = "ModHistory_v1"; // historial de kick / serverban / requestban / ban / unban
const POWERS_STORE = "ModPowers_v1"; // lista de poderes (la manda el juego)

// Game passes conocidos (se suman a los que devuelva Roblox para el universo)
const PASES_CONOCIDOS = [
  { id: 2056594294, nombre: "Slots Premium (slots 4-6)" },
  { id: 2052894842, nombre: "Nivel 100" },
];

// Las semanas van de lunes a domingo, en hora de Colombia (UTC-5)
const OFFSET_HORAS = -5;

// ─────────────────────────────────────────────────────
// Roblox (Open Cloud) - helpers genéricos
// ─────────────────────────────────────────────────────
const DS_BASE = `https://apis.roblox.com/datastores/v1/universes/${ROBLOX_UNIVERSE_ID}/standard-datastores/datastore/entries`;

// fetch con la API key y reintentos si hay límite de velocidad (429) o error del servidor
async function rbx(url, opts = {}, intentos = 3) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, {
      ...opts,
      headers: { "x-api-key": ROBLOX_API_KEY, ...(opts.headers || {}) },
    });
    if ((r.status === 429 || r.status >= 500) && i < intentos) {
      await new Promise((res) => setTimeout(res, 1000 * i));
      continue;
    }
    return r;
  }
}

// Lee una entrada (null si no existe)
async function dsGet(store, key) {
  const r = await rbx(
    `${DS_BASE}/entry?datastoreName=${encodeURIComponent(store)}&entryKey=${encodeURIComponent(key)}`
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`DataStore GET ${store}/${key} ${r.status}: ${await r.text()}`);
  return await r.json();
}

// Escribe (reemplaza) una entrada
async function dsSet(store, key, value) {
  const r = await rbx(
    `${DS_BASE}/entry?datastoreName=${encodeURIComponent(store)}&entryKey=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    }
  );
  if (!r.ok) throw new Error(`DataStore SET ${store}/${key} ${r.status}: ${await r.text()}`);
}

// Lista TODAS las keys de un DataStore (necesita el permiso "List Entries" en la API key)
async function dsKeys(store) {
  const keys = [];
  let cursor = "";
  do {
    const url =
      `${DS_BASE}?datastoreName=${encodeURIComponent(store)}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const r = await rbx(url);
    if (r.status === 404) return keys; // el DataStore todavía no existe
    if (!r.ok) throw new Error(`DataStore LIST ${store} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    for (const k of j.keys || []) keys.push(k.key);
    cursor = j.nextPageCursor || "";
  } while (cursor);
  return keys;
}

// Ejecuta fn sobre cada elemento con un máximo de "n" a la vez
async function enParalelo(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        res[k] = await fn(items[k]);
      }
    })
  );
  return res;
}

const intentar = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

async function guardarBan(userId, datos) {
  await dsSet(PERM_BAN_STORE, String(userId), datos);
}

async function publicarMensaje(topic, datos) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${ROBLOX_UNIVERSE_ID}/topics/${topic}`;
  const r = await rbx(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: JSON.stringify(datos) }),
  });
  if (!r.ok) throw new Error(`Messaging ${r.status}: ${await r.text()}`);
}

async function avisarJuego(datos) {
  await publicarMensaje(TOPIC, datos);
}

async function avatarDe(userId, tamano = "150x150") {
  try {
    const r = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=${tamano}&format=Png`
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

// Convierte varios userIds en { id: name }
async function nombresDe(ids) {
  const mapa = {};
  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100).map(Number);
    try {
      const r = await fetch("https://users.roblox.com/v1/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: lote, excludeBannedUsers: false }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      for (const u of j.data || []) mapa[u.id] = u.name;
    } catch {}
  }
  return mapa;
}

// ─────────────────────────────────────────────────────
// Game passes
// ─────────────────────────────────────────────────────
let cachePases = { t: 0, lista: PASES_CONOCIDOS };

async function listaPases() {
  if (Date.now() - cachePases.t < 10 * 60 * 1000) return cachePases.lista;
  const lista = [...PASES_CONOCIDOS];
  try {
    const r = await fetch(
      `https://games.roblox.com/v1/games/${ROBLOX_UNIVERSE_ID}/game-passes?limit=100&sortOrder=Asc`
    );
    if (r.ok) {
      const j = await r.json();
      for (const p of j.data || []) {
        if (p?.id && !lista.some((x) => x.id === p.id)) {
          lista.push({ id: p.id, nombre: p.displayName || p.name || `Pass ${p.id}` });
        }
      }
    }
  } catch {}
  cachePases = { t: Date.now(), lista };
  return lista;
}

// true / false / null (null = no se pudo verificar, p. ej. inventario privado)
async function poseePase(userId, passId) {
  try {
    const r = await fetch(
      `https://inventory.roblox.com/v1/users/${userId}/items/GamePass/${passId}/is-owned`
    );
    if (!r.ok) return null;
    const t = (await r.text()).trim();
    return t === "true" ? true : t === "false" ? false : null;
  } catch {
    return null;
  }
}

async function pasesDe(userId) {
  const lista = await listaPases();
  const res = await enParalelo(lista, 4, async (p) => ({ ...p, tiene: await poseePase(userId, p.id) }));
  return {
    poseidos: res.filter((p) => p.tiene === true),
    sinVerificar: res.filter((p) => p.tiene === null).length,
  };
}

// ─────────────────────────────────────────────────────
// Poderes (los manda el juego a /powers al iniciar un servidor)
// ─────────────────────────────────────────────────────
let poderes = []; // [{ indice, nombre, icono }]

(async () => {
  try {
    const guardado = await dsGet(POWERS_STORE, "list");
    if (Array.isArray(guardado)) poderes = guardado;
    console.log(`[Powers] ${poderes.length} poderes cargados.`);
  } catch (e) {
    console.error("[Powers] No se pudo cargar la lista:", e.message);
  }
})();

function buscarPoderCache(nombre) {
  const q = nombre.trim().toLowerCase();
  const exacto = poderes.find((p) => p.nombre.toLowerCase() === q);
  if (exacto) return exacto;
  const parecidos = poderes.filter((p) => p.nombre.toLowerCase().includes(q));
  return parecidos.length === 1 ? parecidos[0] : null;
}

// ─────────────────────────────────────────────────────
// Historial de moderación (kick / serverban / requestban / ban / unban)
// DataStore ModHistory_v1, key = userId, valor = lista de eventos
// ─────────────────────────────────────────────────────
const colas = new Map();
function conCola(key, fn) {
  const previa = colas.get(key) || Promise.resolve();
  const siguiente = previa.catch(() => {}).then(fn);
  colas.set(key, siguiente);
  siguiente
    .finally(() => {
      if (colas.get(key) === siguiente) colas.delete(key);
    })
    .catch(() => {});
  return siguiente;
}

function anotarHistorial(userId, evento) {
  return conCola(String(userId), async () => {
    const lista = (await dsGet(HIST_STORE, String(userId))) || [];
    lista.push({ ts: Date.now(), ...evento });
    await dsSet(HIST_STORE, String(userId), lista.slice(-500));
  }).catch((e) => console.error("[Hist] No se pudo anotar:", e.message));
}

// Actualiza el estado de una solicitud de ban (aprobada / rechazada)
function actualizarSolicitud(userId, msgId, cambios) {
  return conCola(String(userId), async () => {
    const lista = await dsGet(HIST_STORE, String(userId));
    if (!Array.isArray(lista)) return;
    const e = lista.find((x) => x.tipo === "requestban" && x.msgId === msgId);
    if (!e) return; // solicitud anterior al registro: no hay nada que actualizar
    Object.assign(e, cambios);
    await dsSet(HIST_STORE, String(userId), lista);
  }).catch((e) => console.error("[Hist] No se pudo actualizar:", e.message));
}

// ─────────────────────────────────────────────────────
// ¿Está el jugador dentro del juego? (pregunta a los servidores por MessagingService)
// ─────────────────────────────────────────────────────
const consultasOnline = new Map();

async function jugadorEnLinea(userId) {
  const requestId = crypto.randomUUID();
  const espera = new Promise((resolve) => {
    consultasOnline.set(requestId, resolve);
    setTimeout(() => resolve(false), 4000);
  });
  try {
    await publicarMensaje(TOPIC_CHECK, { requestId, userId });
  } catch (e) {
    consultasOnline.delete(requestId);
    throw e;
  }
  const enLinea = await espera;
  consultasOnline.delete(requestId);
  return enLinea;
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

const tieneRolAlerta = (interaction) => !!interaction.member?.roles?.cache?.has(ROL_ALERTA);

// Los errores se muestran solo a quien ejecutó el comando
async function errorPrivado(interaction, texto) {
  await interaction.deleteReply().catch(() => {});
  await interaction.followUp({ content: texto, ephemeral: true });
}

// Parte una lista de líneas en varios textos de menos de "max" caracteres
function trocear(encabezado, lineas, max = 3800, sep = "\n") {
  const textos = [];
  let desc = encabezado;
  for (const l of lineas) {
    if (desc.length + l.length + sep.length > max) {
      textos.push(desc);
      desc = "";
    }
    desc += l + sep;
  }
  textos.push(desc);
  return textos.filter((t) => t.trim());
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
  const msg = await ch.send({
    content: ROLES.map((id) => `<@&${id}>`).join(" "),
    embeds: [embed],
    components: [botones],
    allowedMentions: { roles: ROLES },
  });

  // Queda en el historial del jugador (estado "pending" hasta que aprueben o rechacen)
  await anotarHistorial(userId, {
    tipo: "requestban",
    razon: String(reason || "N/A").slice(0, 500),
    mod: requestedBy || "?",
    modId: requestedById || null,
    msgId: msg.id,
    estado: "pending",
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

  const nombre = interaction.options.getString("username", true).trim();
  const razon = interaction.options.getString("reason", true).trim();

  let usuario;
  try {
    usuario = await buscarUsuarioRoblox(nombre);
  } catch (e) {
    return errorPrivado(interaction, "No pude consultar Roblox: " + e.message);
  }
  if (!usuario) {
    return errorPrivado(interaction, `No encontré al usuario de Roblox: ${nombre}`);
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

// ─────────────────────────────────────────────────────
// /slot User Slot Level [Power]   (solo ROL_ALERTA)
// Modifica un slot de un jugador que está FUERA del juego
// ─────────────────────────────────────────────────────
async function comandoSlot(interaction) {
  if (!tieneRolAlerta(interaction)) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const nombre = interaction.options.getString("user", true).trim();
  const numero = interaction.options.getInteger("slot", true);
  const nivel = interaction.options.getInteger("level", true);
  const poderPedido = interaction.options.getString("power");

  let usuario;
  try {
    usuario = await buscarUsuarioRoblox(nombre);
  } catch (e) {
    return errorPrivado(interaction, "No pude consultar Roblox: " + e.message);
  }
  if (!usuario) return errorPrivado(interaction, `No encontré al usuario de Roblox: ${nombre}`);

  // Solo jugadores fuera del juego (si está dentro, su servidor sobrescribiría el cambio al guardar)
  let enLinea;
  try {
    enLinea = await jugadorEnLinea(usuario.id);
  } catch (e) {
    return errorPrivado(
      interaction,
      "No pude verificar si el jugador está dentro del juego (MessagingService falló): " + e.message
    );
  }
  if (enLinea) {
    return errorPrivado(
      interaction,
      `${usuario.name} está dentro del juego. /slot solo funciona con jugadores fuera del juego.`
    );
  }

  let poder = null;
  if (poderPedido) {
    poder = buscarPoderCache(poderPedido);
    if (!poder) {
      return errorPrivado(
        interaction,
        poderes.length
          ? `No existe un poder llamado "${poderPedido}". Usa el autocompletado.`
          : "Todavía no tengo la lista de poderes. Entra un servidor del juego (la manda al iniciar) y reintenta."
      );
    }
  }

  const clave = `jugador_${usuario.id}`;
  let guardado;
  try {
    guardado = await dsGet(SLOTS_STORE, clave);
  } catch (e) {
    return errorPrivado(interaction, "No pude leer los datos del jugador: " + e.message);
  }
  if (!guardado || typeof guardado !== "object") guardado = { version: VERSION_DATOS_SLOTS, slots: {} };
  if (!guardado.slots || typeof guardado.slots !== "object") guardado.slots = {};

  const claveSlot = String(numero);
  const anterior = guardado.slots[claveSlot];
  const anteriorValido = anterior && typeof anterior === "object" ? anterior : null;

  if (!poder && !anteriorValido) {
    return errorPrivado(
      interaction,
      `El slot ${numero} de ${usuario.name} está vacío. Indica también el parámetro "power" para crearlo.`
    );
  }

  let nuevo;
  if (poder) {
    // Reemplaza el slot (igual que /slot dentro del juego): el progreso anterior se pierde
    nuevo = {
      poder: poder.nombre,
      icono: poder.icono,
      indicePoder: poder.indice,
      nivel,
      kills: 0,
      creadoEn: anteriorValido?.creadoEn || Math.floor(Date.now() / 1000),
    };
  } else {
    // Solo cambia el nivel. Se borra "xp" para que SlotsDataStore la recalcule a partir del nivel
    nuevo = { ...anteriorValido, nivel };
    delete nuevo.xp;
    delete nuevo.experiencia;
  }

  guardado.version = VERSION_DATOS_SLOTS;
  guardado.slots[claveSlot] = nuevo;

  try {
    await dsSet(SLOTS_STORE, clave, guardado);
  } catch (e) {
    return errorPrivado(interaction, "No se pudo guardar el slot (DataStore falló): " + e.message);
  }

  const detalle =
    `Slot ${numero}: ${nuevo.poder} nivel ${nivel}` +
    (poder && anteriorValido?.poder ? ` (replaced: ${anteriorValido.poder})` : "");

  // Registro en el canal de acciones
  try {
    const log = new EmbedBuilder()
      .setTitle("Slot Changed [Discord]")
      .setColor(0xFFFFFF)
      .setDescription(`**${usuario.name}** (${usuario.id})`)
      .addFields(
        { name: "Moderator", value: `${interaction.user.username} (${interaction.user.id})` },
        { name: "Details", value: detalle.slice(0, 1000) }
      )
      .setTimestamp();
    const ch = await canal(CANAL_ACCIONES);
    await ch.send({ embeds: [log] });
  } catch (e) {
    console.error("No se pudo registrar el cambio de slot:", e.message);
  }

  let texto = `Slot **${numero}** of **${escapeMarkdown(usuario.name)}** is now **${escapeMarkdown(
    nuevo.poder
  )}** level **${nivel}**.`;
  if (poder && anteriorValido?.poder) texto += `\nReplaced: ${escapeMarkdown(anteriorValido.poder)}`;
  if (numero > 3) texto += "\nSlots 4 to 6 can only be used with the slots game pass.";

  const embed = new EmbedBuilder().setColor(0xFFFFFF).setDescription(texto);
  const avatar = await avatarDe(usuario.id);
  if (avatar) embed.setThumbnail(avatar);
  await interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────
// /information User   (solo ROL_ALERTA)
// ─────────────────────────────────────────────────────
const ETIQUETAS_HIST = {
  kick: "KICK",
  serverban: "SERVER BAN",
  requestban: "REQUEST BAN",
  ban: "BAN",
  unban: "UNBAN",
};

function lineaHistorial(e) {
  const ts = Math.floor((e.ts || 0) / 1000);
  let extra = "";
  if (e.tipo === "requestban") {
    extra =
      e.estado === "approved"
        ? `\nResult: Approved by ${e.por || "?"}`
        : e.estado === "rejected"
        ? `\nResult: Rejected by ${e.por || "?"}`
        : "\nResult: Pending";
  }
  return (
    `<t:${ts}:f> — **${ETIQUETAS_HIST[e.tipo] || e.tipo}**\n` +
    `Moderator: ${escapeMarkdown(String(e.mod || "?"))}\n` +
    `Reason: ${escapeMarkdown(String(e.razon || "N/A")).slice(0, 300)}${extra}`
  );
}

async function comandoInformation(interaction) {
  if (!tieneRolAlerta(interaction)) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  const nombre = interaction.options.getString("user", true).trim();
  let usuario;
  try {
    usuario = await buscarUsuarioRoblox(nombre);
  } catch (e) {
    return errorPrivado(interaction, "No pude consultar Roblox: " + e.message);
  }
  if (!usuario) return errorPrivado(interaction, `No encontré al usuario de Roblox: ${nombre}`);

  const [banR, slotsR, histR, pasesR, avatar] = await Promise.all([
    intentar(dsGet(PERM_BAN_STORE, String(usuario.id))),
    intentar(dsGet(SLOTS_STORE, `jugador_${usuario.id}`)),
    intentar(dsGet(HIST_STORE, String(usuario.id))),
    intentar(pasesDe(usuario.id)),
    avatarDe(usuario.id, "420x420"),
  ]);

  // Estado del ban actual
  let estadoBan;
  if (!banR.ok) {
    estadoBan = "Could not check (DataStore error).";
  } else if (banR.v) {
    const b = banR.v;
    const quien = typeof b.bannedBy === "number" ? `ID ${b.bannedBy} [in-game]` : String(b.bannedBy || "N/A");
    estadoBan =
      `**BANNED**\nReason: ${escapeMarkdown(String(b.reason || "N/A"))}\nBanned by: ${escapeMarkdown(quien)}` +
      (b.approvedBy ? `\nApproved by: ${escapeMarkdown(String(b.approvedBy))}` : "");
  } else {
    estadoBan = "Not banned.";
  }

  // Slots
  let textoSlots;
  if (!slotsR.ok) {
    textoSlots = "Could not read (DataStore error).";
  } else {
    const slots = slotsR.v?.slots || {};
    const lineas = [];
    for (let n = 1; n <= CANTIDAD_SLOTS; n++) {
      const s = slots[String(n)];
      if (s && typeof s === "object") {
        lineas.push(
          `**${n}.** ${escapeMarkdown(String(s.poder || "?"))} — Level ${s.nivel ?? 0} (${s.kills || 0} kills)`
        );
      } else {
        lineas.push(`**${n}.** Empty`);
      }
    }
    textoSlots = lineas.join("\n");
  }

  // Game passes
  let textoPases;
  if (!pasesR.ok) {
    textoPases = "Could not check.";
  } else {
    const { poseidos, sinVerificar } = pasesR.v;
    textoPases = poseidos.length ? poseidos.map((p) => `• ${escapeMarkdown(p.nombre)}`).join("\n") : "None.";
    if (sinVerificar) textoPases += `\n(Could not verify ${sinVerificar}: private inventory)`;
  }

  // Historial
  const hist = histR.ok && Array.isArray(histR.v) ? histR.v : [];
  const cuenta = (t) => hist.filter((e) => e.tipo === t).length;
  const resumen =
    `Kicks: ${cuenta("kick")}\nServer Bans: ${cuenta("serverban")}\nRequest Bans: ${cuenta("requestban")}\n` +
    `Bans (previous): ${cuenta("ban")} | Unbans: ${cuenta("unban")}` +
    (histR.ok ? "" : "\n(history could not be read)");

  const principal = new EmbedBuilder()
    .setTitle(`Information: ${usuario.name}`)
    .setColor(0xFFFFFF)
    .setDescription(`**${escapeMarkdown(usuario.name)}** (${usuario.id})`)
    .addFields(
      { name: "Ban status", value: estadoBan.slice(0, 1000) },
      { name: "Slots", value: textoSlots.slice(0, 1000) },
      { name: "Game Passes", value: textoPases.slice(0, 1000) },
      { name: "Moderation summary", value: resumen.slice(0, 1000) }
    )
    .setFooter({ text: "History is recorded since the logging was enabled" })
    .setTimestamp();
  if (avatar) principal.setThumbnail(avatar);

  await interaction.editReply({ embeds: [principal] });

  // Lista completa del historial (más reciente primero), un embed por mensaje
  const lineas = [...hist].sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(lineaHistorial);
  const encabezado = `# MODERATION HISTORY\n**${escapeMarkdown(usuario.name)}**\n\n`;
  const textos = lineas.length
    ? trocear(encabezado, lineas, 3800, "\n\n")
    : [encabezado + "No records."];
  for (const t of textos) {
    await interaction.followUp({ embeds: [new EmbedBuilder().setColor(0xFFFFFF).setDescription(t)] });
  }
}

// ─────────────────────────────────────────────────────
// /banlist   (solo ROL_ALERTA)
// ─────────────────────────────────────────────────────
async function comandoBanList(interaction) {
  if (!tieneRolAlerta(interaction)) {
    return interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  let keys;
  try {
    keys = (await dsKeys(PERM_BAN_STORE)).filter((k) => /^\d+$/.test(k));
  } catch (e) {
    return errorPrivado(
      interaction,
      "No pude listar los baneos (¿la API key tiene el permiso List Entries?): " + e.message
    );
  }

  if (!keys.length) {
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xFFFFFF).setDescription("# BANNED PLAYERS\n\nNo banned players.")],
    });
  }

  const [razones, nombres] = await Promise.all([
    enParalelo(keys, 5, async (k) => {
      try {
        const v = await dsGet(PERM_BAN_STORE, k);
        return String(v?.reason || "N/A");
      } catch {
        return "?";
      }
    }),
    nombresDe(keys),
  ]);

  const filas = keys
    .map((k, i) => ({ nombre: nombres[k] || `ID:${k}`, razon: razones[i] }))
    .sort((a, b) => a.nombre.toLowerCase().localeCompare(b.nombre.toLowerCase()));

  const lineas = filas.map((f) => {
    let razon = f.razon.replace(/\s+/g, " ").trim().slice(0, 200) || "N/A";
    if (!/[.!?]$/.test(razon)) razon += ".";
    return `${escapeMarkdown(f.nombre)} = ${escapeMarkdown(razon)}`;
  });

  const textos = trocear("# BANNED PLAYERS\n\n", lineas);
  const embeds = textos.map((t) => new EmbedBuilder().setColor(0xFFFFFF).setDescription(t));
  embeds[embeds.length - 1].setFooter({ text: `Total: ${filas.length}` });

  await interaction.editReply({ embeds: [embeds[0]] });
  for (const e of embeds.slice(1)) await interaction.followUp({ embeds: [e] });
}

// ─────────────────────────────────────────────────────
// Interacciones
// ─────────────────────────────────────────────────────
const COMANDOS = {
  modlist: comandoModList,
  requestban: comandoRequestBan,
  slot: comandoSlot,
  information: comandoInformation,
  banlist: comandoBanList,
};

client.on("interactionCreate", async (interaction) => {
  // Autocompletado del poder en /slot
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "slot") {
      if (!tieneRolAlerta(interaction)) return interaction.respond([]).catch(() => {});
      const q = String(interaction.options.getFocused() || "").toLowerCase();
      const opciones = poderes
        .filter((p) => p.nombre.toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ name: p.nombre, value: p.nombre }));
      await interaction.respond(opciones).catch(() => {});
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const manejador = COMANDOS[interaction.commandName];
    if (!manejador) return;
    try {
      await manejador(interaction);
    } catch (e) {
      console.error(e);
      const texto = "An error occurred: " + e.message;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(texto).catch(() => {});
      } else {
        await interaction.reply({ content: texto, ephemeral: true }).catch(() => {});
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

      // Historial: la solicitud queda aprobada y se anota el ban
      await actualizarSolicitud(userId, interaction.message.id, {
        estado: "approved",
        por: interaction.user.tag,
      });
      await anotarHistorial(userId, {
        tipo: "ban",
        razon: reason.slice(0, 500),
        mod: interaction.user.tag,
        modId: interaction.user.id,
        via: `requestban de ${requestedBy}`,
      });

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
      await actualizarSolicitud(userId, interaction.message.id, {
        estado: "rejected",
        por: interaction.user.tag,
      });

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
  // Registra los comandos en cada servidor donde está el bot (aparecen al instante)
  const definiciones = [
    {
      name: "modlist",
      description: "Shows this week's and last week's message counts for users with staff roles",
    },
    {
      name: "requestban",
      description: "Sends a ban request for a Roblox user",
      options: [
        { name: "username", description: "Roblox username of the player", type: 3, required: true },
        { name: "reason", description: "Reason for the ban", type: 3, required: true, max_length: 500 },
      ],
    },
    {
      name: "slot",
      description: "Edits a slot of a player who is NOT in the game",
      options: [
        { name: "user", description: "Roblox username of the player", type: 3, required: true },
        { name: "slot", description: "Slot number (1-6)", type: 4, required: true, min_value: 1, max_value: CANTIDAD_SLOTS },
        { name: "level", description: "Level (0-100)", type: 4, required: true, min_value: 0, max_value: 100 },
        {
          name: "power",
          description: "Power (optional: only to create or replace the slot)",
          type: 3,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: "information",
      description: "Shows slots, game passes, bans and moderation history of a Roblox user",
      options: [{ name: "user", description: "Roblox username of the player", type: 3, required: true }],
    },
    {
      name: "banlist",
      description: "Shows all the banned players and the reason",
    },
  ];

  for (const guild of client.guilds.cache.values()) {
    for (const def of definiciones) {
      try {
        await guild.commands.create(def);
      } catch (e) {
        console.error(`No se pudo registrar /${def.name} en ${guild.name}:`, e.message);
      }
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

    // Historial del jugador
    if (Number.isInteger(userId)) {
      await anotarHistorial(userId, {
        tipo: type,
        razon: String(reason || "N/A").slice(0, 500),
        mod: admin || "?",
        modId: adminId || null,
        via: "in-game",
      });
    }

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

    // Historial del jugador (solo kick y serverban)
    if (type === "kick" || type === "serverban") {
      await anotarHistorial(userId, {
        tipo: type,
        razon: String(reason || "N/A").slice(0, 500),
        mod: moderator || "?",
        modId: moderatorId || null,
      });
    }

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

// El juego avisa que un jugador está dentro (respuesta a la consulta ModCheck)
app.post("/online", (req, res) => {
  const { requestId } = req.body || {};
  const resolver = typeof requestId === "string" ? consultasOnline.get(requestId) : null;
  if (resolver) resolver(true);
  res.json({ ok: true });
});

// El juego manda la lista de poderes (para el autocompletado y el icono de /slot)
app.post("/powers", async (req, res) => {
  try {
    const lista = Array.isArray(req.body.powers) ? req.body.powers : [];
    const limpia = lista
      .filter((p) => p && Number.isInteger(p.indice) && typeof p.nombre === "string" && p.nombre)
      .map((p) => ({
        indice: p.indice,
        nombre: p.nombre.slice(0, 40),
        icono: typeof p.icono === "string" ? p.icono.slice(0, 100) : "",
      }))
      .sort((a, b) => a.indice - b.indice);

    if (limpia.length && JSON.stringify(limpia) !== JSON.stringify(poderes)) {
      poderes = limpia;
      await dsSet(POWERS_STORE, "list", limpia);
      console.log(`[Powers] Lista actualizada (${limpia.length} poderes).`);
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
    const l = await fetch(
      `https://apis.roblox.com/datastores/v1/universes/${U}/standard-datastores/datastore/entries?datastoreName=${PERM_BAN_STORE}&limit=1`,
      { headers }
    );
    console.log(`[Check] DataStore LIST -> ${l.status} ${l.ok || l.status === 404 ? "OK" : await l.text()}`);
  } catch (e) {
    console.log("[Check] DataStore LIST error:", e.message);
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
