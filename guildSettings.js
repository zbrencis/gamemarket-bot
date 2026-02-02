//guildsettings.js
import { query } from "./db.js";

export const DEFAULT_GUILD_SETTINGS = {
  mod_role_id: (process.env.MOD_ROLE_ID || "").trim() || null,
  tickets_category_name: (process.env.TICKETS_CATEGORY_NAME || "Trade Tickets").trim(),
  disputes_category_name: (process.env.DISPUTES_CATEGORY_NAME || "Trade Disputes").trim(),
  closed_category_name: (process.env.CLOSED_TICKETS_CATEGORY_NAME || "Closed Tickets").trim(),
  history_channel_name: (process.env.HISTORY_CHANNEL_NAME || "trade-history").trim(),
  ops_channel_name: (process.env.OPS_CHANNEL_NAME || "trade-ops").trim(),
  dm_notifications: String(process.env.DM_NOTIFICATIONS || "true").toLowerCase() === "true",
};

const CACHE = new Map();
const TTL_MS = 5 * 60 * 1000;

function cleanStr(v) {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    mod_role_id: cleanStr(row.mod_role_id),
    tickets_category_name: cleanStr(row.tickets_category_name),
    disputes_category_name: cleanStr(row.disputes_category_name),
    closed_category_name: cleanStr(row.closed_category_name),
    history_channel_name: cleanStr(row.history_channel_name),
    ops_channel_name: cleanStr(row.ops_channel_name),
    dm_notifications: row.dm_notifications == null ? null : Boolean(row.dm_notifications),
  };
}

export function mergeSettings(dbSettings) {
  const s = dbSettings || {};
  return {
    mod_role_id: s.mod_role_id ?? DEFAULT_GUILD_SETTINGS.mod_role_id,
    tickets_category_name: s.tickets_category_name ?? DEFAULT_GUILD_SETTINGS.tickets_category_name,
    disputes_category_name: s.disputes_category_name ?? DEFAULT_GUILD_SETTINGS.disputes_category_name,
    closed_category_name: s.closed_category_name ?? DEFAULT_GUILD_SETTINGS.closed_category_name,
    history_channel_name: s.history_channel_name ?? DEFAULT_GUILD_SETTINGS.history_channel_name,
    ops_channel_name: s.ops_channel_name ?? DEFAULT_GUILD_SETTINGS.ops_channel_name,
    dm_notifications: s.dm_notifications ?? DEFAULT_GUILD_SETTINGS.dm_notifications,
  };
}

export async function getGuildSettings(guildId) {
  const now = Date.now();
  const cached = CACHE.get(guildId);
  if (cached && cached.expiresAt > now) return cached.settings;

  const res = await query(`select * from guild_settings where guild_id=$1`, [guildId]);
  const dbSettings = res.rowCount ? normalizeRow(res.rows[0]) : null;
  const settings = mergeSettings(dbSettings);

  CACHE.set(guildId, { settings, expiresAt: now + TTL_MS });
  return settings;
}

export async function upsertGuildSettings(guildId, patch) {
  const keys = [
    "mod_role_id",
    "tickets_category_name",
    "disputes_category_name",
    "closed_category_name",
    "history_channel_name",
    "ops_channel_name",
    "dm_notifications",
  ];

  const currentRes = await query(`select * from guild_settings where guild_id=$1`, [guildId]);
  const current = currentRes.rowCount ? normalizeRow(currentRes.rows[0]) : {};
  const next = { ...current };

  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }

  // Asegura columnas nuevas si tu tabla guild_settings no las tiene todavía:
  // (Si ya las tienes, no pasa nada. Si no, crea la migración correspondiente.)

  await query(
    `
    insert into guild_settings
      (guild_id, mod_role_id, tickets_category_name, disputes_category_name, closed_category_name, history_channel_name, ops_channel_name, dm_notifications, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8, now())
    on conflict (guild_id) do update set
      mod_role_id = excluded.mod_role_id,
      tickets_category_name = excluded.tickets_category_name,
      disputes_category_name = excluded.disputes_category_name,
      closed_category_name = excluded.closed_category_name,
      history_channel_name = excluded.history_channel_name,
      ops_channel_name = excluded.ops_channel_name,
      dm_notifications = excluded.dm_notifications,
      updated_at = now()
    `,
    [
      guildId,
      next.mod_role_id || null,
      next.tickets_category_name || null,
      next.disputes_category_name || null,
      next.closed_category_name || null,
      next.history_channel_name || null,
      next.ops_channel_name || null,
      next.dm_notifications == null ? null : Boolean(next.dm_notifications),
    ]
  );

  CACHE.delete(guildId);
  return await getGuildSettings(guildId);
}

export async function resetGuildSettings(guildId) {
  await query(`delete from guild_settings where guild_id=$1`, [guildId]);
  CACHE.delete(guildId);
  return await getGuildSettings(guildId);
}
