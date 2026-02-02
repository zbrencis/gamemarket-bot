// index.js (multi-server) — aligned with your deploy-commands.js
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionsBitField,
  Events,
} from "discord.js";

import { query, withTx } from "./db.js";
import { getGuildSettings, upsertGuildSettings, resetGuildSettings } from "./guildSettings.js";

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const EPHEMERAL = 64;

const TRADE_EXPIRE_HOURS = Number(process.env.TRADE_EXPIRE_HOURS || "72");
const REVIEW_WINDOW_HOURS = Number(process.env.REVIEW_WINDOW_HOURS || "24");
const TRADE_BUMP_COOLDOWN_MIN = Number(process.env.TRADE_BUMP_COOLDOWN_MIN || "30");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  startExpirationLoop();
  startTicketCloseLoop();
});

client.on("guildCreate", async (guild) => {
  try {
    const owner = await guild.fetchOwner();
    await owner.send(
      "👋 Thanks for inviting **Marketplace Bot**!\n\n" +
        "To finish setup, run:\n" +
        "`/setup apply`\n\n" +
        "You can check configuration anytime with:\n" +
        "`/setup view`"
    );

    console.log(`✅ Joined guild: ${guild.name} (${guild.id}) — waiting for /setup apply`);
  } catch (e) {
    console.warn("Could not DM guild owner on join:", e?.message || e);
  }
});

// =========================
// Helpers
// =========================
function truncate(str, n = 1024) {
  if (!str) return "";
  const s = String(str);
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function cleanName(s, max = 90) {
  const out = String(s ?? "").trim();
  if (!out) return null;
  return out.length > max ? out.slice(0, max) : out;
}

function safeShort(id, n = 8) {
  return String(id || "").slice(0, n);
}

async function resolveUsername(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName || member.user.username;
  } catch {
    return `User ${userId}`;
  }
}

function isSetupAdmin(member) {
  try {
    if (!member) return false;
    if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
    if (member.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
    return false;
  } catch {
    return false;
  }
}

function isModerator(member, settings) {
  try {
    if (!member) return false;

    const modRoleId = settings?.mod_role_id || null;
    if (modRoleId && member.roles?.cache?.has(modRoleId)) return true;

    if (member.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;
    if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;

    return false;
  } catch {
    return false;
  }
}

async function dmUser(userId, contentOrPayload) {
  try {
    const u = await client.users.fetch(userId);
    if (!u) return false;
    await u.send(contentOrPayload);
    return true;
  } catch {
    return false;
  }
}

async function auditLog({ guildId, actorId, action, tradeId = null, channelId = null, meta = null }) {
  try {
    await query(
      `
      insert into audit_logs (guild_id, actor_id, action, trade_id, channel_id, meta, created_at)
      values ($1,$2,$3,$4,$5,$6, now())
      `,
      [guildId, actorId || null, action, tradeId, channelId, meta ? JSON.stringify(meta) : null]
    );
  } catch {
    // ignore
  }
}

// =========================
// Guild resources (plug & play)
// =========================
async function ensureCategoryByName(guild, name) {
  const n = String(name || "").trim();
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === n.toLowerCase()
  );
  if (existing) return { channel: existing, created: false };

  const created = await guild.channels.create({ name: n, type: ChannelType.GuildCategory });
  return { channel: created, created: true };
}

async function ensureTextChannelByName(guild, name) {
  const n = String(name || "").trim();
  const lower = n.toLowerCase();
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === lower);
  if (existing) return { channel: existing, created: false };

  const created = await guild.channels.create({ name: n, type: ChannelType.GuildText });
  return { channel: created, created: true };
}

async function ensureTicketsCategory(guild, settings) {
  return ensureCategoryByName(guild, settings.tickets_category_name);
}
async function ensureClosedTicketsCategory(guild, settings) {
  return ensureCategoryByName(guild, settings.closed_category_name);
}
async function ensureDisputesCategory(guild, settings) {
  return ensureCategoryByName(guild, settings.disputes_category_name);
}
async function ensureHistoryChannel(guild, settings) {
  return ensureTextChannelByName(guild, settings.history_channel_name);
}

// Ops channel: mods only
async function ensureOpsChannel(guild, settings) {
  const res = await ensureTextChannelByName(guild, settings.ops_channel_name);
  const ch = res.channel;

  try {
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }];

    if (settings.mod_role_id) {
      overwrites.push({
        id: settings.mod_role_id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
        ],
      });
    }

    if (me) {
      overwrites.push({
        id: me.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageMessages,
        ],
      });
    }

    await ch.permissionOverwrites.set(overwrites);
  } catch {
    // ignore
  }

  return res;
}

async function ensureGuildResources(guild, settings) {
  const results = [];

  const tickets = await ensureTicketsCategory(guild, settings);
  results.push({ label: "tickets_category", ...tickets });

  const disputes = await ensureDisputesCategory(guild, settings);
  results.push({ label: "disputes_category", ...disputes });

  const closed = await ensureClosedTicketsCategory(guild, settings);
  results.push({ label: "closed_category", ...closed });

  const history = await ensureHistoryChannel(guild, settings);
  results.push({ label: "history_channel", ...history });

  const ops = await ensureOpsChannel(guild, settings);
  results.push({ label: "ops_channel", ...ops });

  return results;
}

async function postOps(guild, settings, text, embed = null) {
  try {
    const ops = (await ensureOpsChannel(guild, settings)).channel;
    if (!ops?.isTextBased()) return;
    await ops.send(embed ? { content: text, embeds: [embed] } : { content: text });
  } catch {
    // ignore
  }
}

// =========================
// Trade UI rows
// =========================
function tradeActionRowOpen() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("trade_offer").setLabel("➕ Send offer").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("trade_withdraw").setLabel("🗑️ Withdraw my offer").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("trade_view_offers").setLabel("📩 View offers").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("trade_cancel").setLabel("❌ Cancel").setStyle(ButtonStyle.Secondary)
  );
}

function ticketActionRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_done:${tradeId}`).setLabel("✅ I completed").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_dispute:${tradeId}`).setLabel("⚠️ Dispute").setStyle(ButtonStyle.Danger)
  );
}

function reviewButtonsRow(trade) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`review_open:${trade.id}:${trade.acceptor_id}`)
      .setLabel("⭐ Review acceptor")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`review_open:${trade.id}:${trade.creator_id}`)
      .setLabel("⭐ Review creator")
      .setStyle(ButtonStyle.Secondary)
  );
}

function disputeResolveRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dispute_resolve:${tradeId}`).setLabel("🧑‍⚖️ Resolve Dispute").setStyle(ButtonStyle.Primary)
  );
}

function disputeProofsRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`proof_add:${tradeId}:PROOF`).setLabel("📎 Add proof").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`proof_add:${tradeId}:NOTE`).setLabel("📝 Add note").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`proof_view:${tradeId}`).setLabel("👀 View proofs").setStyle(ButtonStyle.Primary)
  );
}

async function updateTradeEmbedStatus(message, newStatusLabel) {
  const oldEmbed = message.embeds?.[0];
  if (!oldEmbed) return;

  const embed = EmbedBuilder.from(oldEmbed);
  embed.data.fields = (embed.data.fields || []).filter((f) => f.name !== "Status");
  embed.addFields({ name: "Status", value: newStatusLabel, inline: true });

  await message.edit({ embeds: [embed] });
}

async function updateTradePostStatusByTrade(guild, trade, newStatusLabel, disableComponents = true) {
  try {
    const channel = await guild.channels.fetch(trade.channel_id);
    if (!channel || !channel.isTextBased()) return;

    const msg = await channel.messages.fetch(trade.message_id);
    await updateTradeEmbedStatus(msg, newStatusLabel);
    if (disableComponents) await msg.edit({ components: [] });
  } catch (e) {
    console.warn("Could not update trade post:", e?.code || e?.message || e);
  }
}

function normalizeDisputeResult(raw) {
  const r = String(raw || "").trim().toUpperCase();
  if (["COMPLETED", "CANCELED", "EXPIRED"].includes(r)) return r;
  return null;
}

function labelForFinalStatus(status) {
  switch (status) {
    case "COMPLETED":
      return "✅ RESOLVED: COMPLETED";
    case "CANCELED":
      return "⛔ RESOLVED: CANCELED";
    case "EXPIRED":
      return "⚫ RESOLVED: EXPIRED";
    default:
      return status;
  }
}

// =========================
// Reputation queries
// =========================
function starsText(avg) {
  const full = Math.round(avg);
  return "★".repeat(full) + "☆".repeat(Math.max(0, 5 - full));
}

function badgeList({ avgStars, reviewCount, completedTrades }) {
  const badges = [];
  if (reviewCount >= 5 && avgStars >= 4.5) badges.push("⭐ Trusted Trader");
  if (completedTrades >= 20) badges.push("🏆 Top Seller");
  return badges.length ? badges.join("  ") : "—";
}

async function getReputation(userId) {
  const agg = await query(
    `
    select
      coalesce(avg(stars), 0)::float as avg_stars,
      count(*)::int as review_count
    from reviews
    where to_user_id = $1
    `,
    [userId]
  );

  const completedAsCreator = await query(
    `select count(*)::int as c from trades where creator_id = $1 and status = 'COMPLETED'`,
    [userId]
  );
  const completedAsAcceptor = await query(
    `select count(*)::int as c from trades where acceptor_id = $1 and status = 'COMPLETED'`,
    [userId]
  );

  const avgStars = Number(agg.rows[0]?.avg_stars || 0);
  const reviewCount = Number(agg.rows[0]?.review_count || 0);
  const c1 = Number(completedAsCreator.rows[0]?.c || 0);
  const c2 = Number(completedAsAcceptor.rows[0]?.c || 0);

  return { avgStars, reviewCount, completedTrades: c1 + c2 };
}

async function getLatestReviews(userId, limit = 5) {
  const res = await query(
    `
    select from_user_id, stars, comment, created_at
    from reviews
    where to_user_id = $1
    order by created_at desc
    limit $2
    `,
    [userId, limit]
  );
  return res.rows;
}

// =========================
// DB helpers
// =========================
async function getTradeByMessageId(messageId) {
  const res = await query(`select * from trades where message_id=$1`, [messageId]);
  return res.rowCount ? res.rows[0] : null;
}

async function getTradeById(tradeId) {
  const res = await query(`select * from trades where id=$1`, [tradeId]);
  return res.rowCount ? res.rows[0] : null;
}

// =========================
// Expiration job (OPEN trades)
// =========================
async function expireOldTradesOnce(guild) {
  const res = await query(
    `
    select id, channel_id, message_id
    from trades
    where status = 'OPEN'
      and guild_id = $1
      and created_at < now() - ($2 || ' hours')::interval
    order by created_at asc
    limit 25
    `,
    [guild.id, String(TRADE_EXPIRE_HOURS)]
  );

  if (!res.rowCount) return;

  const settings = await getGuildSettings(guild.id);

  for (const t of res.rows) {
    try {
      await withTx(async (tx) => {
        await tx.query(
          `update trades set status='EXPIRED', expired_at=now(), updated_at=now()
           where id=$1 and status='OPEN'`,
          [t.id]
        );
        await tx.query(`update offers set status='REJECTED' where trade_id=$1 and status='PENDING'`, [t.id]);
      });

      try {
        const ch = await guild.channels.fetch(t.channel_id);
        if (ch && ch.isTextBased()) {
          const msg = await ch.messages.fetch(t.message_id);
          await updateTradeEmbedStatus(msg, "⚫ EXPIRED");
          await msg.edit({ components: [] });
        }
      } catch {
        // ignore
      }

      await auditLog({ guildId: guild.id, actorId: null, action: "TRADE_EXPIRED", tradeId: t.id, channelId: t.channel_id });
      await postOps(guild, settings, `⚫ Trade expired: \`${safeShort(t.id)}\``);
    } catch (e) {
      console.warn("Error expiring trade:", t.id, e?.message || e);
    }
  }
}

function startExpirationLoop() {
  setInterval(async () => {
    try {
      for (const [, guild] of client.guilds.cache) {
        await expireOldTradesOnce(guild);
      }
    } catch (e) {
      console.warn("Expiration loop error:", e?.message || e);
    }
  }, 5 * 60 * 1000);
}

// =========================
// History posting
// =========================
async function postTradeHistory(guild, tradeId) {
  try {
    const tRes = await query(`select * from trades where id=$1`, [tradeId]);
    if (!tRes.rowCount) return;
    const trade = tRes.rows[0];
    if (trade.status !== "COMPLETED") return;

    const settings = await getGuildSettings(guild.id);

    const creatorName = await resolveUsername(guild, trade.creator_id);
    const acceptorName = trade.acceptor_id ? await resolveUsername(guild, trade.acceptor_id) : "—";
    const historyChannel = (await ensureHistoryChannel(guild, settings)).channel;

    const embed = new EmbedBuilder()
      .setTitle("✅ Trade Completed")
      .addFields(
        { name: "Participants", value: `${creatorName} ↔ ${acceptorName}` },
        { name: "Have / Offer", value: truncate(trade.have_text, 1024) },
        { name: "Want", value: truncate(trade.want_text, 1024) }
      )
      .setFooter({ text: `Trade ID: ${trade.id}` });

    await historyChannel.send({ embeds: [embed] });
  } catch (e) {
    console.warn("Could not post history:", e?.message || e);
  }
}

// =========================
// Ticket close rules (after reviews or deadline)
// =========================
async function bothReviewsSubmitted(tradeId) {
  const tRes = await query(`select creator_id, acceptor_id from trades where id=$1`, [tradeId]);
  if (!tRes.rowCount) return false;
  const t = tRes.rows[0];
  if (!t.creator_id || !t.acceptor_id) return false;

  const rRes = await query(
    `
    select count(*)::int as c
    from reviews
    where trade_id = $1
      and (
        (from_user_id = $2 and to_user_id = $3)
        or
        (from_user_id = $3 and to_user_id = $2)
      )
    `,
    [tradeId, t.creator_id, t.acceptor_id]
  );

  return Number(rRes.rows[0]?.c || 0) >= 2;
}

// Close: move to Closed Tickets, read-only, hide from participants
async function archiveAndLockTicket(guild, tradeId, reason = "reviews/timeout") {
  const tRes = await query(`select * from trades where id=$1`, [tradeId]);
  if (!tRes.rowCount) return;
  const trade = tRes.rows[0];

  if (!trade.ticket_channel_id) return;
  if (trade.ticket_closed_at) return;

  const settings = await getGuildSettings(guild.id);

  const ch = await guild.channels.fetch(trade.ticket_channel_id).catch(() => null);
  if (!ch) {
    await query(`update trades set ticket_closed_at=now(), updated_at=now() where id=$1`, [tradeId]);
    return;
  }

  const closedCat = (await ensureClosedTicketsCategory(guild, settings)).channel;

  try {
    await ch.setParent(closedCat.id, { lockPermissions: false });
  } catch {
    // ignore
  }

  // deny participants view
  try {
    if (trade.creator_id) await ch.permissionOverwrites.edit(trade.creator_id, { ViewChannel: false });
    if (trade.acceptor_id) await ch.permissionOverwrites.edit(trade.acceptor_id, { ViewChannel: false });
  } catch {
    // ignore
  }

  // read-only for everyone (in case visible to mods/bot)
  try {
    await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false, AddReactions: false });
  } catch {
    // ignore
  }

  // ensure bot can still operate
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (me) {
      await ch.permissionOverwrites.edit(me.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageChannels: true,
        ManageMessages: true,
      });
    }
  } catch {
    // ignore
  }

  // allow mods to view (optional)
  if (settings.mod_role_id) {
    try {
      await ch.permissionOverwrites.edit(settings.mod_role_id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
      });
    } catch {
      // ignore
    }
  }

  try {
    await ch.setName(`closed-${safeShort(tradeId)}`);
  } catch {
    // ignore
  }

  if (ch.isTextBased()) {
    await ch.send(`🔒 Ticket archived (${reason}). This channel is now read-only.`).catch(() => null);
  }

  await query(`update trades set ticket_closed_at=now(), updated_at=now() where id=$1`, [tradeId]);

  await auditLog({
    guildId: guild.id,
    actorId: null,
    action: "TICKET_ARCHIVED",
    tradeId,
    channelId: trade.ticket_channel_id,
    meta: { reason },
  });

  await postOps(guild, settings, `🔒 Ticket archived: \`${safeShort(tradeId)}\` (${reason})`);
}

async function closeTicketsByDeadlineOnce(guild) {
  const res = await query(
    `
    select id
    from trades
    where status='COMPLETED'
      and guild_id = $1
      and ticket_channel_id is not null
      and ticket_closed_at is null
      and review_deadline_at is not null
      and now() >= review_deadline_at
    order by review_deadline_at asc
    limit 25
    `,
    [guild.id]
  );

  for (const row of res.rows) {
    await archiveAndLockTicket(guild, row.id, "review deadline reached");
  }
}

function startTicketCloseLoop() {
  setInterval(async () => {
    try {
      for (const [, guild] of client.guilds.cache) {
        await closeTicketsByDeadlineOnce(guild);
      }
    } catch (e) {
      console.warn("Ticket close loop error:", e?.message || e);
    }
  }, 5 * 60 * 1000);
}

// =========================
// Dispute + proofs
// =========================
async function markDisputedAndEscalate(guild, tradeId, triggeredByUserId, currentChannel) {
  const trade = await getTradeById(tradeId);
  if (!trade) return { ok: false, msg: "Trade not found." };
  if (String(trade.guild_id) !== String(guild.id)) return { ok: false, msg: "Guild mismatch." };

  const isParticipant = triggeredByUserId === trade.creator_id || triggeredByUserId === trade.acceptor_id;
  if (!isParticipant) return { ok: false, msg: "Only participants can open a dispute." };

  const settings = await getGuildSettings(guild.id);

  await query(
    `update trades
     set status='DISPUTED', disputed_at=now(), assigned_mod_id=null, updated_at=now()
     where id=$1`,
    [tradeId]
  );

  await updateTradePostStatusByTrade(guild, trade, "⚠️ DISPUTED", true);

  await auditLog({
    guildId: guild.id,
    actorId: triggeredByUserId,
    action: "DISPUTE_OPENED",
    tradeId,
    channelId: currentChannel?.id || trade.ticket_channel_id || null,
  });

  const disputesCat = (await ensureDisputesCategory(guild, settings)).channel;

  if (currentChannel && currentChannel.type === ChannelType.GuildText) {
    try {
      await currentChannel.setParent(disputesCat.id, { lockPermissions: false });
    } catch {
      // ignore
    }

    // ensure bot access
    try {
      const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (me) {
        await currentChannel.permissionOverwrites.edit(me.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          ManageChannels: true,
          ManageMessages: true,
        });
      }
    } catch {
      // ignore
    }

    // mods access
    if (settings.mod_role_id) {
      try {
        await currentChannel.permissionOverwrites.edit(settings.mod_role_id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          ManageMessages: true,
        });
      } catch {
        // ignore
      }
    }

    // participants still talk
    try {
      if (trade.creator_id) {
        await currentChannel.permissionOverwrites.edit(trade.creator_id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
        });
      }
      if (trade.acceptor_id) {
        await currentChannel.permissionOverwrites.edit(trade.acceptor_id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
        });
      }
    } catch {
      // ignore
    }
  }

  if (currentChannel?.isTextBased()) {
    const ping = settings.mod_role_id ? `<@&${settings.mod_role_id}> ` : "";
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Dispute Opened")
      .setDescription(
        `Dispute opened for Trade **${safeShort(tradeId)}**.\n\n` +
          `📌 Please add screenshots / proof using the buttons below.\n` +
          `🧑‍⚖️ Moderators: click **Resolve Dispute** when ready.`
      )
      .addFields(
        { name: "Participants", value: `<@${trade.creator_id}> ↔ <@${trade.acceptor_id || "unknown"}>` },
        { name: "Have / Offer", value: truncate(trade.have_text, 1024) },
        { name: "Want", value: truncate(trade.want_text, 1024) }
      );

    await currentChannel
      .send({
        content: `⚠️ ${ping}`.trim(),
        embeds: [embed],
        components: [disputeResolveRow(tradeId), disputeProofsRow(tradeId)],
      })
      .catch(() => null);
  }

  await postOps(
    guild,
    settings,
    `⚠️ Dispute opened: \`${safeShort(tradeId)}\` in <#${currentChannel?.id || trade.ticket_channel_id}>`
  );

  // DM participants (optional)
  if (settings.dm_notifications) {
    const msg = `⚠️ Dispute opened for trade ${safeShort(tradeId)} in **${guild.name}**.\nPlease provide proof in the dispute channel.`;
    if (trade.creator_id) await dmUser(trade.creator_id, msg);
    if (trade.acceptor_id) await dmUser(trade.acceptor_id, msg);
  }

  return { ok: true, msg: "⚠️ Dispute opened and escalated." };
}

async function tryInsertDisputeLog({ tradeId, guildId, channelId, moderatorId, result, reason }) {
  try {
    await query(
      `
      insert into dispute_logs (trade_id, guild_id, channel_id, moderator_id, result, reason, created_at)
      values ($1,$2,$3,$4,$5,$6, now())
      `,
      [tradeId, guildId, channelId, moderatorId, result, reason]
    );
  } catch {
    // ignore
  }
}

async function resolveDisputeAndClose({ guild, tradeId, moderatorId, result, reason, channel }) {
  const trade = await getTradeById(tradeId);
  if (!trade) return { ok: false, msg: "Trade not found." };
  if (String(trade.guild_id) !== String(guild.id)) return { ok: false, msg: "Guild mismatch." };

  const settings = await getGuildSettings(guild.id);

  await query(`update trades set status=$2, updated_at=now() where id=$1`, [tradeId, result]);
  await updateTradePostStatusByTrade(guild, trade, labelForFinalStatus(result), true);

  if (result === "COMPLETED") await postTradeHistory(guild, tradeId);

  await tryInsertDisputeLog({
    tradeId,
    guildId: guild.id,
    channelId: channel?.id || trade.ticket_channel_id || null,
    moderatorId,
    result,
    reason,
  });

  await auditLog({
    guildId: guild.id,
    actorId: moderatorId,
    action: "DISPUTE_RESOLVED",
    tradeId,
    channelId: channel?.id || trade.ticket_channel_id || null,
    meta: { result, reason },
  });

  if (channel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle("🧑‍⚖️ Dispute Resolved")
      .addFields(
        { name: "Result", value: result, inline: true },
        { name: "Moderator", value: `<@${moderatorId}>`, inline: true },
        { name: "Reason", value: truncate(reason || "—", 1024) }
      )
      .setFooter({ text: `Trade ID: ${safeShort(tradeId)}` });

    await channel.send({ embeds: [embed] }).catch(() => null);
  }

  await postOps(guild, settings, `🧑‍⚖️ Dispute resolved: \`${safeShort(tradeId)}\` → **${result}** (by <@${moderatorId}>)`);

  if (settings.dm_notifications) {
    const msg =
      `🧑‍⚖️ Dispute resolved for trade ${safeShort(tradeId)} in **${guild.name}**.\nResult: **${result}**.\nReason: ${truncate(
        reason,
        400
      )}`;
    if (trade.creator_id) await dmUser(trade.creator_id, msg);
    if (trade.acceptor_id) await dmUser(trade.acceptor_id, msg);
  }

  await archiveAndLockTicket(guild, tradeId, `dispute resolved: ${result}`);
  return { ok: true, msg: `✅ Dispute resolved as ${result} and ticket closed.` };
}

async function addProof({ tradeId, guildId, channelId, userId, kind, content }) {
  await query(
    `
    insert into trade_proofs (trade_id, guild_id, channel_id, user_id, kind, content, created_at)
    values ($1,$2,$3,$4,$5,$6, now())
    `,
    [tradeId, guildId, channelId, userId, kind, content]
  );
}

async function listProofs(tradeId, limit = 10) {
  const res = await query(
    `
    select user_id, kind, content, created_at
    from trade_proofs
    where trade_id=$1
    order by created_at desc
    limit $2
    `,
    [tradeId, limit]
  );
  return res.rows;
}

// =========================
// Market commands (stats/top)
// =========================
async function marketStatsEmbed(guildId) {
  const q = async (sql, params) => (await query(sql, params)).rows[0];

  const openNow = await q(`select count(*)::int as c from trades where guild_id=$1 and status='OPEN'`, [guildId]);

  const d7 = await q(
    `
    select
      sum((status='COMPLETED')::int)::int as completed,
      sum((status='DISPUTED')::int)::int as disputed,
      count(*)::int as created
    from trades
    where guild_id=$1 and created_at >= now() - interval '7 days'
    `,
    [guildId]
  );

  const d30 = await q(
    `
    select
      sum((status='COMPLETED')::int)::int as completed,
      sum((status='DISPUTED')::int)::int as disputed,
      count(*)::int as created
    from trades
    where guild_id=$1 and created_at >= now() - interval '30 days'
    `,
    [guildId]
  );

  return new EmbedBuilder()
    .setTitle("📊 Marketplace Stats")
    .addFields(
      { name: "Open now", value: String(openNow?.c || 0), inline: true },
      { name: "Last 7 days — created", value: String(d7?.created || 0), inline: true },
      { name: "Last 7 days — completed", value: String(d7?.completed || 0), inline: true },
      { name: "Last 7 days — disputed", value: String(d7?.disputed || 0), inline: true },
      { name: "Last 30 days — created", value: String(d30?.created || 0), inline: true },
      { name: "Last 30 days — completed", value: String(d30?.completed || 0), inline: true },
      { name: "Last 30 days — disputed", value: String(d30?.disputed || 0), inline: true }
    );
}

async function marketTopEmbed(interaction, range) {
  const guildId = interaction.guildId;
  const where =
    range === "7d"
      ? `and t.completed_at >= now() - interval '7 days'`
      : range === "30d"
      ? `and t.completed_at >= now() - interval '30 days'`
      : ``;

  const res = await query(
    `
    with completed as (
      select creator_id as user_id, id from trades t where t.guild_id=$1 and t.status='COMPLETED' ${where}
      union all
      select acceptor_id as user_id, id from trades t where t.guild_id=$1 and t.status='COMPLETED' ${where}
    ),
    counts as (
      select user_id, count(*)::int as completed_trades
      from completed
      where user_id is not null
      group by user_id
    ),
    rep as (
      select to_user_id as user_id, coalesce(avg(stars),0)::float as avg_stars, count(*)::int as review_count
      from reviews
      group by to_user_id
    )
    select c.user_id, c.completed_trades,
           coalesce(r.avg_stars,0)::float as avg_stars,
           coalesce(r.review_count,0)::int as review_count
    from counts c
    left join rep r on r.user_id = c.user_id
    order by c.completed_trades desc, r.avg_stars desc
    limit 10
    `,
    [guildId]
  );

  const embed = new EmbedBuilder().setTitle(`🏆 Top Traders (${range || "all"})`);

  if (!res.rowCount) {
    embed.setDescription("No data yet.");
    return embed;
  }

  const lines = [];
  for (let i = 0; i < res.rows.length; i++) {
    const row = res.rows[i];
    const name = await resolveUsername(interaction.guild, row.user_id);
    const stars = starsText(Number(row.avg_stars || 0));
    lines.push(
      `**#${i + 1}** — ${name} • completed: **${row.completed_trades}** • ${stars} (${Number(row.avg_stars || 0).toFixed(
        2
      )}) • reviews: ${row.review_count}`
    );
  }

  embed.setDescription(lines.join("\n").slice(0, 4000));
  return embed;
}

// =========================
// Trades list/my/info/bump & offers my
// =========================
async function tradeListEmbed(interaction, { qText = null, userId = null, limit = 10 }) {
  const guildId = interaction.guildId;
  const lim = Math.max(1, Math.min(Number(limit || 10), 25));

  const params = [guildId];
  let where = `where guild_id=$1 and status='OPEN'`;

  if (userId) {
    params.push(userId);
    where += ` and creator_id=$${params.length}`;
  }
  if (qText && String(qText).trim()) {
    params.push(`%${String(qText).trim()}%`);
    where += ` and (have_text ilike $${params.length} or want_text ilike $${params.length})`;
  }

  params.push(lim);

  const res = await query(
    `
    select id, creator_id, channel_id, message_id, have_text, want_text, created_at
    from trades
    ${where}
    order by created_at desc
    limit $${params.length}
    `,
    params
  );

  const embed = new EmbedBuilder().setTitle("🟢 Open trades");

  if (!res.rowCount) {
    embed.setDescription("No open trades found.");
    return embed;
  }

  const lines = [];
  for (const t of res.rows) {
    const creator = await resolveUsername(interaction.guild, t.creator_id);
    const jump = `https://discord.com/channels/${guildId}/${t.channel_id}/${t.message_id}`;
    lines.push(
      `• **${safeShort(t.id)}** by **${creator}** — [jump](${jump})\n  Have: ${truncate(t.have_text, 80)}\n  Want: ${truncate(
        t.want_text,
        80
      )}`
    );
  }

  embed.setDescription(lines.join("\n").slice(0, 4000));
  return embed;
}

async function tradeInfoEmbed(interaction, tradeId) {
  const trade = await getTradeById(tradeId);
  if (!trade) return { ok: false, embed: new EmbedBuilder().setTitle("Trade info").setDescription("Trade not found.") };
  if (String(trade.guild_id) !== String(interaction.guildId)) {
    return { ok: false, embed: new EmbedBuilder().setTitle("Trade info").setDescription("Guild mismatch.") };
  }

  const offers = await query(`select count(*)::int as c from offers where trade_id=$1`, [tradeId]);
  const proofs = await query(`select count(*)::int as c from trade_proofs where trade_id=$1`, [tradeId]);

  const creator = await resolveUsername(interaction.guild, trade.creator_id);
  const acceptor = trade.acceptor_id ? await resolveUsername(interaction.guild, trade.acceptor_id) : "—";

  const embed = new EmbedBuilder()
    .setTitle(`ℹ️ Trade ${safeShort(trade.id)}`)
    .addFields(
      { name: "Status", value: trade.status, inline: true },
      { name: "Creator", value: creator, inline: true },
      { name: "Acceptor", value: acceptor, inline: true },
      { name: "Offers", value: String(offers.rows[0]?.c || 0), inline: true },
      { name: "Proofs/Notes", value: String(proofs.rows[0]?.c || 0), inline: true },
      { name: "Have / Offer", value: truncate(trade.have_text, 1024) },
      { name: "Want", value: truncate(trade.want_text, 1024) }
    );

  return { ok: true, embed };
}

async function canBumpTrade(guildId, actorId, tradeId) {
  const res = await query(
    `
    select created_at
    from audit_logs
    where guild_id=$1 and actor_id=$2 and action='TRADE_BUMP' and trade_id=$3
    order by created_at desc
    limit 1
    `,
    [guildId, actorId, tradeId]
  );

  if (!res.rowCount) return { ok: true };
  const last = new Date(res.rows[0].created_at).getTime();
  const mins = (Date.now() - last) / 60000;
  if (mins >= TRADE_BUMP_COOLDOWN_MIN) return { ok: true };
  return { ok: false, waitMin: Math.ceil(TRADE_BUMP_COOLDOWN_MIN - mins) };
}

async function offerMyEmbed(interaction, limit = 10) {
  const lim = Math.max(1, Math.min(Number(limit || 10), 25));
  const res = await query(
    `
    select o.id, o.trade_id, o.offer_text, o.created_at
    from offers o
    join trades t on t.id = o.trade_id
    where o.bidder_id=$1 and o.status='PENDING' and t.guild_id=$2
    order by o.created_at desc
    limit $3
    `,
    [interaction.user.id, interaction.guildId, lim]
  );

  const embed = new EmbedBuilder().setTitle("📩 My pending offers");
  if (!res.rowCount) {
    embed.setDescription("You have no pending offers.");
    return embed;
  }

  const lines = res.rows.map((o) => `• Trade **${safeShort(o.trade_id)}** — ${truncate(o.offer_text, 120)}`);
  embed.setDescription(lines.join("\n").slice(0, 4000));
  return embed;
}

// =========================
// Main interaction handler
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // =========================
    // /setup view|apply|reset
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }
      if (!isSetupAdmin(interaction.member)) {
        return interaction.reply({ content: "❌ Only admins / Manage Server can run /setup.", flags: EPHEMERAL });
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "view") {
        const s = await getGuildSettings(interaction.guild.id);
        const embed = new EmbedBuilder()
          .setTitle("Guild Settings")
          .setDescription("Current configuration for this server:")
          .addFields(
            { name: "mod_role_id", value: s.mod_role_id ? `<@&${s.mod_role_id}> (${s.mod_role_id})` : "—" },
            { name: "tickets_category_name", value: s.tickets_category_name },
            { name: "disputes_category_name", value: s.disputes_category_name },
            { name: "closed_category_name", value: s.closed_category_name },
            { name: "history_channel_name", value: s.history_channel_name },
            { name: "ops_channel_name", value: s.ops_channel_name },
            { name: "dm_notifications", value: String(Boolean(s.dm_notifications)) }
          );
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "reset") {
        const s = await resetGuildSettings(interaction.guild.id);
        const created = await ensureGuildResources(interaction.guild, s);

        const embed = new EmbedBuilder()
          .setTitle("✅ Settings Reset")
          .setDescription("Reset to defaults from .env and ensured channels/categories exist.")
          .addFields(
            { name: "mod_role_id", value: s.mod_role_id ? `<@&${s.mod_role_id}> (${s.mod_role_id})` : "—" },
            { name: "tickets_category_name", value: s.tickets_category_name },
            { name: "disputes_category_name", value: s.disputes_category_name },
            { name: "closed_category_name", value: s.closed_category_name },
            { name: "history_channel_name", value: s.history_channel_name },
            { name: "ops_channel_name", value: s.ops_channel_name },
            { name: "dm_notifications", value: String(Boolean(s.dm_notifications)) },
            {
              name: "resources",
              value: created
                .map((r) => `• ${r.label}: ${r.created ? "created" : "exists"} (${r.channel.name})`)
                .join("\n")
                .slice(0, 1024),
            }
          );

        await auditLog({ guildId: interaction.guild.id, actorId: interaction.user.id, action: "SETUP_RESET" });
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      // apply
      if (sub === "apply") {
        const modRole = interaction.options.getRole("mod_role");
        const ticketsCat = interaction.options.getString("tickets_category");
        const disputesCat = interaction.options.getString("disputes_category");
        const closedCat = interaction.options.getString("closed_category");
        const historyChan = interaction.options.getString("history_channel");
        const opsChan = interaction.options.getString("ops_channel");
        const dmNotifications = interaction.options.getBoolean("dm_notifications");

        const patch = {};
        if (modRole) patch.mod_role_id = modRole.id;
        if (ticketsCat != null) patch.tickets_category_name = cleanName(ticketsCat, 90);
        if (disputesCat != null) patch.disputes_category_name = cleanName(disputesCat, 90);
        if (closedCat != null) patch.closed_category_name = cleanName(closedCat, 90);
        if (historyChan != null) patch.history_channel_name = cleanName(historyChan, 90);
        if (opsChan != null) patch.ops_channel_name = cleanName(opsChan, 90);
        if (dmNotifications != null) patch.dm_notifications = Boolean(dmNotifications);

        const updated = await upsertGuildSettings(interaction.guild.id, patch);
        const ensured = await ensureGuildResources(interaction.guild, updated);

        // ✅ FIX: removed invalid "guides" references that caused crashes

        const embed = new EmbedBuilder()
          .setTitle("✅ Settings Applied (Plug & Play)")
          .setDescription("Settings saved and required categories/channels ensured.")
          .addFields(
            { name: "mod_role_id", value: updated.mod_role_id ? `<@&${updated.mod_role_id}> (${updated.mod_role_id})` : "—" },
            { name: "tickets_category_name", value: updated.tickets_category_name },
            { name: "disputes_category_name", value: updated.disputes_category_name },
            { name: "closed_category_name", value: updated.closed_category_name },
            { name: "history_channel_name", value: updated.history_channel_name },
            { name: "ops_channel_name", value: updated.ops_channel_name },
            { name: "dm_notifications", value: String(Boolean(updated.dm_notifications)) },
            {
              name: "resources",
              value: ensured
                .map((r) => `• ${r.label}: ${r.created ? "created" : "exists"} (${r.channel.name})`)
                .join("\n")
                .slice(0, 1024),
            }
          );

        await auditLog({ guildId: interaction.guild.id, actorId: interaction.user.id, action: "SETUP_APPLY", meta: patch });
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }
    }

    // =========================
    // /rep
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "rep") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }

      const user = interaction.options.getUser("user", true);
      const rep = await getReputation(user.id);
      const latest = await getLatestReviews(user.id, 5);

      const name = await resolveUsername(interaction.guild, user.id);
      const badgeStr = badgeList(rep);

      const embed = new EmbedBuilder()
        .setTitle(`Reputation: ${name}`)
        .addFields(
          { name: "Stars", value: `${starsText(rep.avgStars)}  (${rep.avgStars.toFixed(2)}/5)`, inline: true },
          { name: "Reviews", value: String(rep.reviewCount), inline: true },
          { name: "Completed trades", value: String(rep.completedTrades), inline: true },
          { name: "Badges", value: badgeStr }
        );

      if (latest.length) {
        const lines = latest.map((r) => {
          const s = "★".repeat(r.stars) + "☆".repeat(5 - r.stars);
          const c = r.comment ? ` — ${truncate(r.comment, 120)}` : "";
          return `${s}${c}`;
        });
        embed.addFields({ name: "Latest reviews", value: lines.join("\n").slice(0, 1024) });
      } else {
        embed.addFields({ name: "Latest reviews", value: "No reviews yet." });
      }

      return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    }

    // =========================
    // /market stats|top
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "market") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "stats") {
        const embed = await marketStatsEmbed(interaction.guildId);
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "top") {
        const range = interaction.options.getString("range") || "all";
        const embed = await marketTopEmbed(interaction, range);
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }
    }

    // =========================
    // /disputes queue|assign|unassign (mods only)
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "disputes") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }

      const settings = await getGuildSettings(interaction.guildId);
      if (!isModerator(interaction.member, settings)) {
        return interaction.reply({ content: "❌ Only moderators can use /disputes.", flags: EPHEMERAL });
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "queue") {
        const res = await query(
          `
          select id, ticket_channel_id, creator_id, acceptor_id, disputed_at, assigned_mod_id
          from trades
          where guild_id=$1 and status='DISPUTED'
          order by disputed_at asc nulls last
          limit 25
          `,
          [interaction.guildId]
        );

        const embed = new EmbedBuilder().setTitle("⚠️ Disputes Queue");
        if (!res.rowCount) {
          embed.setDescription("Queue empty ✅");
          return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
        }

        const lines = [];
        for (const t of res.rows) {
          const ch = t.ticket_channel_id ? `<#${t.ticket_channel_id}>` : "—";
          const assigned = t.assigned_mod_id ? `<@${t.assigned_mod_id}>` : "—";
          lines.push(`• **${safeShort(t.id)}** — ch: ${ch} — assigned: ${assigned}`);
        }
        embed.setDescription(lines.join("\n").slice(0, 4000));
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "assign") {
        const tradeId = interaction.options.getString("trade_id", true);
        const mod = interaction.options.getUser("mod", true);

        const trade = await getTradeById(tradeId);
        if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
        if (String(trade.guild_id) !== String(interaction.guildId)) {
          return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
        }
        if (trade.status !== "DISPUTED") {
          return interaction.reply({ content: "Trade is not DISPUTED.", flags: EPHEMERAL });
        }

        await query(`update trades set assigned_mod_id=$2, updated_at=now() where id=$1`, [tradeId, mod.id]);

        await auditLog({
          guildId: interaction.guildId,
          actorId: interaction.user.id,
          action: "DISPUTE_ASSIGNED",
          tradeId,
          channelId: trade.ticket_channel_id || null,
          meta: { assigned_mod_id: mod.id },
        });

        await postOps(
          interaction.guild,
          settings,
          `🧷 Dispute assigned: \`${safeShort(tradeId)}\` → <@${mod.id}> (by <@${interaction.user.id}>)`
        );

        if (settings.dm_notifications) {
          await dmUser(mod.id, `🧷 You were assigned dispute ${safeShort(tradeId)} in **${interaction.guild.name}**.`);
        }

        return interaction.reply({ content: `✅ Assigned ${safeShort(tradeId)} to <@${mod.id}>`, flags: EPHEMERAL });
      }

      if (sub === "unassign") {
        const tradeId = interaction.options.getString("trade_id", true);

        const trade = await getTradeById(tradeId);
        if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
        if (String(trade.guild_id) !== String(interaction.guildId)) {
          return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
        }

        await query(`update trades set assigned_mod_id=null, updated_at=now() where id=$1`, [tradeId]);

        await auditLog({
          guildId: interaction.guildId,
          actorId: interaction.user.id,
          action: "DISPUTE_UNASSIGNED",
          tradeId,
          channelId: trade.ticket_channel_id || null,
        });

        await postOps(interaction.guild, settings, `🧷 Dispute unassigned: \`${safeShort(tradeId)}\` (by <@${interaction.user.id}>)`);

        return interaction.reply({ content: `✅ Unassigned ${safeShort(tradeId)}`, flags: EPHEMERAL });
      }
    }

    // =========================
    // /trade create|list|my|info|bump
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "trade") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }

      const sub = interaction.options.getSubcommand(true);

      if (sub === "create") {
        const haveText = interaction.options.getString("have", true);
        const wantText = interaction.options.getString("want", true);

        await interaction.reply({ content: "Creating trade…", flags: EPHEMERAL });

        const channel = interaction.channel;
        if (!channel?.isTextBased()) return;

        const embed = new EmbedBuilder()
          .setTitle("🛒 New Trade")
          .addFields(
            { name: "Have / Offer", value: truncate(haveText, 1024) },
            { name: "Want", value: truncate(wantText, 1024) },
            { name: "Status", value: "🟢 OPEN", inline: true }
          )
          .setFooter({ text: `Creator: ${interaction.user.username}` });

        const msg = await channel.send({ embeds: [embed], components: [tradeActionRowOpen()] });

        await query(
          `insert into trades
           (guild_id, channel_id, message_id, creator_id, have_text, want_text, status, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,'OPEN', now(), now())`,
          [interaction.guildId, channel.id, msg.id, interaction.user.id, haveText, wantText]
        );

        const settings = await getGuildSettings(interaction.guildId);
        await auditLog({ guildId: interaction.guildId, actorId: interaction.user.id, action: "TRADE_CREATED", channelId: channel.id });
        await postOps(interaction.guild, settings, `🟢 Trade created by <@${interaction.user.id}> in <#${channel.id}>`);

        await interaction.editReply({ content: "✅ Trade created in the channel." });
        return;
      }

      if (sub === "list") {
        const qText = interaction.options.getString("q");
        const user = interaction.options.getUser("user");
        const limit = interaction.options.getInteger("limit") ?? 10;

        const embed = await tradeListEmbed(interaction, { qText, userId: user?.id || null, limit });
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "my") {
        const limit = Math.max(1, Math.min(Number(interaction.options.getInteger("limit") ?? 10), 25));
        const res = await query(
          `
          select id, status, channel_id, message_id, created_at
          from trades
          where guild_id=$1 and creator_id=$2
          order by created_at desc
          limit $3
          `,
          [interaction.guildId, interaction.user.id, limit]
        );

        const embed = new EmbedBuilder().setTitle("📌 My recent trades");
        if (!res.rowCount) {
          embed.setDescription("No trades found.");
          return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
        }

        const lines = res.rows.map((t) => {
          const jump = `https://discord.com/channels/${interaction.guildId}/${t.channel_id}/${t.message_id}`;
          return `• **${safeShort(t.id)}** — ${t.status} — [jump](${jump})`;
        });

        embed.setDescription(lines.join("\n").slice(0, 4000));
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "info") {
        const tradeId = interaction.options.getString("id", true);
        const out = await tradeInfoEmbed(interaction, tradeId);
        return interaction.reply({ embeds: [out.embed], flags: EPHEMERAL });
      }

      if (sub === "bump") {
        const tradeId = interaction.options.getString("id", true);
        const trade = await getTradeById(tradeId);
        if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
        if (String(trade.guild_id) !== String(interaction.guildId)) {
          return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
        }
        if (trade.status !== "OPEN") {
          return interaction.reply({ content: "Only OPEN trades can be bumped.", flags: EPHEMERAL });
        }

        const settings = await getGuildSettings(interaction.guildId);
        const isMod = isModerator(interaction.member, settings);
        if (trade.creator_id !== interaction.user.id && !isMod) {
          return interaction.reply({ content: "Only the creator or a moderator can bump.", flags: EPHEMERAL });
        }

        const cool = await canBumpTrade(interaction.guildId, interaction.user.id, tradeId);
        if (!cool.ok) {
          return interaction.reply({ content: `⏳ Cooldown. Try again in ~${cool.waitMin} min.`, flags: EPHEMERAL });
        }

        const channel = await interaction.guild.channels.fetch(trade.channel_id).catch(() => null);
        if (!channel?.isTextBased()) return interaction.reply({ content: "Channel not found.", flags: EPHEMERAL });

        const embed = new EmbedBuilder()
          .setTitle("🛒 New Trade (BUMP)")
          .addFields(
            { name: "Have / Offer", value: truncate(trade.have_text, 1024) },
            { name: "Want", value: truncate(trade.want_text, 1024) },
            { name: "Status", value: "🟢 OPEN", inline: true }
          )
          .setFooter({ text: `Original Trade ID: ${trade.id}` });

        const msg = await channel.send({ embeds: [embed], components: [tradeActionRowOpen()] });

        // point trade to newest message
        await query(`update trades set message_id=$2, channel_id=$3, updated_at=now() where id=$1`, [tradeId, msg.id, channel.id]);

        await auditLog({
          guildId: interaction.guildId,
          actorId: interaction.user.id,
          action: "TRADE_BUMP",
          tradeId,
          channelId: channel.id,
        });

        await postOps(interaction.guild, settings, `🔁 Trade bumped: \`${safeShort(tradeId)}\` by <@${interaction.user.id}> in <#${channel.id}>`);
        return interaction.reply({ content: "✅ Bumped.", flags: EPHEMERAL });
      }
    }

    // =========================
    // /offer my
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "offer") {
      if (!interaction.guild) {
        return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      }
      const sub = interaction.options.getSubcommand(true);
      if (sub === "my") {
        const limit = interaction.options.getInteger("limit") ?? 10;
        const embed = await offerMyEmbed(interaction, limit);
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }
    }

    // =========================
    // Buttons (trade post)
    // =========================

    // Withdraw my offer
    if (interaction.isButton() && interaction.customId === "trade_withdraw") {
      const trade = await getTradeByMessageId(interaction.message.id);
      if (!trade) return interaction.reply({ content: "I couldn't find this trade in the database.", flags: EPHEMERAL });
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      const oRes = await query(
        `select id from offers where trade_id=$1 and bidder_id=$2 and status='PENDING' order by created_at desc limit 1`,
        [trade.id, interaction.user.id]
      );
      if (!oRes.rowCount) {
        return interaction.reply({ content: "You don't have a pending offer on this trade.", flags: EPHEMERAL });
      }

      const offerId = oRes.rows[0].id;
      await query(`update offers set status='WITHDRAWN' where id=$1 and status='PENDING'`, [offerId]);

      const settings = interaction.guild ? await getGuildSettings(interaction.guild.id) : null;
      if (interaction.guild && settings) {
        await auditLog({
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          action: "OFFER_WITHDRAWN",
          tradeId: trade.id,
          channelId: trade.channel_id,
        });
        await postOps(interaction.guild, settings, `🗑️ Offer withdrawn by <@${interaction.user.id}> on trade \`${safeShort(trade.id)}\``);
      }

      return interaction.reply({ content: "✅ Your offer has been withdrawn.", flags: EPHEMERAL });
    }

    // Cancel trade (atomic)
    if (interaction.isButton() && interaction.customId === "trade_cancel") {
      const trade = await getTradeByMessageId(interaction.message.id);
      if (!trade) return interaction.reply({ content: "I couldn't find this trade in the database.", flags: EPHEMERAL });

      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can cancel this trade.", flags: EPHEMERAL });
      }
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      await withTx(async (tx) => {
        await tx.query(`update trades set status='CANCELED', updated_at=now() where id=$1 and status='OPEN'`, [trade.id]);
        await tx.query(`update offers set status='REJECTED' where trade_id=$1 and status='PENDING'`, [trade.id]);
      });

      await updateTradeEmbedStatus(interaction.message, "🔴 CANCELED");
      await interaction.update({ components: [] });

      const settings = interaction.guild ? await getGuildSettings(interaction.guild.id) : null;
      if (interaction.guild && settings) {
        await auditLog({
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          action: "TRADE_CANCELED",
          tradeId: trade.id,
          channelId: trade.channel_id,
        });
        await postOps(interaction.guild, settings, `🔴 Trade canceled: \`${safeShort(trade.id)}\` by <@${interaction.user.id}>`);
      }
      return;
    }

    // Send offer -> Modal
    if (interaction.isButton() && interaction.customId === "trade_offer") {
      const trade = await getTradeByMessageId(interaction.message.id);
      if (!trade) return interaction.reply({ content: "I couldn't find this trade in the database.", flags: EPHEMERAL });
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }
      if (trade.creator_id === interaction.user.id) {
        return interaction.reply({ content: "You can't send an offer to yourself 😅", flags: EPHEMERAL });
      }

      const existing = await query(
        `select id from offers where trade_id=$1 and bidder_id=$2 and status='PENDING' limit 1`,
        [trade.id, interaction.user.id]
      );
      if (existing.rowCount) {
        return interaction.reply({
          content: "You already have a pending offer on this trade. Use **🗑️ Withdraw my offer** first if you want to change it.",
          flags: EPHEMERAL,
        });
      }

      const modal = new ModalBuilder().setCustomId(`offer_submit:${trade.id}`).setTitle("Send offer");

      const offerText = new TextInputBuilder()
        .setCustomId("offer_text")
        .setLabel("What are you offering?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800);

      const requestText = new TextInputBuilder()
        .setCustomId("request_text")
        .setLabel("What do you want in return?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800);

      const notes = new TextInputBuilder()
        .setCustomId("notes")
        .setLabel("Notes (optional): region, schedule, etc.")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(800);

      modal.addComponents(
        new ActionRowBuilder().addComponents(offerText),
        new ActionRowBuilder().addComponents(requestText),
        new ActionRowBuilder().addComponents(notes)
      );

      await interaction.showModal(modal);
      return;
    }

    // Modal submit: save offer
    if (interaction.isModalSubmit() && interaction.customId.startsWith("offer_submit:")) {
      const tradeId = interaction.customId.split(":")[1];
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }
      if (trade.creator_id === interaction.user.id) {
        return interaction.reply({ content: "You can't send an offer to yourself 😅", flags: EPHEMERAL });
      }

      const offerText = interaction.fields.getTextInputValue("offer_text");
      const requestText = interaction.fields.getTextInputValue("request_text");
      const notes = interaction.fields.getTextInputValue("notes") || null;

      try {
        await query(
          `insert into offers (trade_id, bidder_id, offer_text, request_text, notes, status, created_at)
           values ($1,$2,$3,$4,$5,'PENDING', now())`,
          [tradeId, interaction.user.id, offerText, requestText, notes]
        );
      } catch {
        return interaction.reply({
          content: "You already have a pending offer on this trade. Withdraw it first if you want to change it.",
          flags: EPHEMERAL,
        });
      }

      if (interaction.guild) {
        const settings = await getGuildSettings(interaction.guild.id);
        await auditLog({
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          action: "OFFER_CREATED",
          tradeId,
          channelId: trade.channel_id,
        });
        await postOps(interaction.guild, settings, `📩 Offer created by <@${interaction.user.id}> on trade \`${safeShort(tradeId)}\``);

        if (settings.dm_notifications) {
          await dmUser(
            trade.creator_id,
            `📩 New offer on your trade ${safeShort(tradeId)} in **${interaction.guild.name}**.\nUse **View offers** on the trade post.`
          );
        }
      }

      return interaction.reply({
        content: "✅ Offer sent. You can withdraw it anytime using **🗑️ Withdraw my offer**.",
        flags: EPHEMERAL,
      });
    }

    // View offers -> Select menu (creator only)
    if (interaction.isButton() && interaction.customId === "trade_view_offers") {
      const trade = await getTradeByMessageId(interaction.message.id);
      if (!trade) return interaction.reply({ content: "I couldn't find this trade in the database.", flags: EPHEMERAL });
      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can view offers.", flags: EPHEMERAL });
      }
      if (!interaction.guild) return interaction.reply({ content: "This button only works inside a server.", flags: EPHEMERAL });

      const oRes = await query(
        `select id, bidder_id, offer_text
         from offers
         where trade_id=$1 and status='PENDING'
         order by created_at asc
         limit 25`,
        [trade.id]
      );

      if (!oRes.rowCount) return interaction.reply({ content: "No pending offers yet.", flags: EPHEMERAL });

      const options = [];
      for (let i = 0; i < oRes.rows.length; i++) {
        const o = oRes.rows[i];
        const username = await resolveUsername(interaction.guild, o.bidder_id);
        options.push({
          label: `Offer #${i + 1} (${username})`,
          description: truncate(String(o.offer_text).replace(/\s+/g, " "), 80),
          value: String(o.id),
        });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(`offer_pick:${trade.id}`)
        .setPlaceholder("Select an offer to view / accept")
        .addOptions(options);

      return interaction.reply({
        content: "📩 Pending offers (pick one):",
        components: [new ActionRowBuilder().addComponents(select)],
        flags: EPHEMERAL,
      });
    }

    // Pick offer -> details + Accept/Reject
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("offer_pick:")) {
      const tradeId = interaction.customId.split(":")[1];
      const offerId = interaction.values[0];

      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      if (trade.creator_id !== interaction.user.id) return interaction.reply({ content: "Only the creator can do this.", flags: EPHEMERAL });
      if (!interaction.guild) return interaction.reply({ content: "This only works inside a server.", flags: EPHEMERAL });

      const oRes = await query(`select * from offers where id=$1 and trade_id=$2`, [offerId, tradeId]);
      if (!oRes.rowCount) return interaction.reply({ content: "Offer not found.", flags: EPHEMERAL });

      const offer = oRes.rows[0];
      const bidderName = await resolveUsername(interaction.guild, offer.bidder_id);

      const embed = new EmbedBuilder()
        .setTitle("Offer details")
        .addFields(
          { name: "From", value: bidderName },
          { name: "Offers", value: truncate(offer.offer_text, 1024) },
          { name: "Wants", value: truncate(offer.request_text, 1024) },
          { name: "Notes", value: offer.notes ? truncate(offer.notes, 1024) : "(no notes)" }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`offer_accept:${offer.id}`).setLabel("✅ Accept this offer").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`offer_reject:${offer.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({ embeds: [embed], components: [row], flags: EPHEMERAL });
    }

    // Reject offer
    if (interaction.isButton() && interaction.customId.startsWith("offer_reject:")) {
      const offerId = interaction.customId.split(":")[1];

      const oRes = await query(`select trade_id from offers where id=$1`, [offerId]);
      if (!oRes.rowCount) return interaction.reply({ content: "Offer not found.", flags: EPHEMERAL });

      const tradeId = oRes.rows[0].trade_id;
      const tRes = await query(`select creator_id, status, guild_id, channel_id from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      const trade = tRes.rows[0];
      if (trade.creator_id !== interaction.user.id) return interaction.reply({ content: "Only the creator can reject offers.", flags: EPHEMERAL });
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      await query(`update offers set status='REJECTED' where id=$1 and status='PENDING'`, [offerId]);

      if (interaction.guild) {
        const settings = await getGuildSettings(interaction.guild.id);
        await auditLog({
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          action: "OFFER_REJECTED",
          tradeId,
          channelId: trade.channel_id,
        });
        await postOps(interaction.guild, settings, `❌ Offer rejected by <@${interaction.user.id}> on trade \`${safeShort(tradeId)}\``);
      }

      return interaction.reply({ content: "❌ Offer rejected.", flags: EPHEMERAL });
    }

    // Accept offer -> create ticket (transaction)
    if (interaction.isButton() && interaction.customId.startsWith("offer_accept:")) {
      const offerId = interaction.customId.split(":")[1];

      const oRes = await query(`select * from offers where id=$1`, [offerId]);
      if (!oRes.rowCount) return interaction.reply({ content: "Offer not found.", flags: EPHEMERAL });
      const offer = oRes.rows[0];

      const trade = await getTradeById(offer.trade_id);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      if (!interaction.guild) return interaction.reply({ content: "This only works inside a server.", flags: EPHEMERAL });
      if (trade.creator_id !== interaction.user.id) return interaction.reply({ content: "Only the creator can accept offers.", flags: EPHEMERAL });
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }
      if (String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      try {
        await withTx(async (tx) => {
          const lock = await tx.query(`select id from trades where id=$1 and status='OPEN' for update`, [trade.id]);
          if (!lock.rowCount) throw new Error("Trade no longer OPEN");

          const okOffer = await tx.query(
            `select id from offers where id=$1 and trade_id=$2 and status='PENDING' for update`,
            [offer.id, trade.id]
          );
          if (!okOffer.rowCount) throw new Error("Offer no longer PENDING");

          await tx.query(
            `update trades
             set status='ACCEPTED', accepted_offer_id=$1, acceptor_id=$2, updated_at=now()
             where id=$3 and status='OPEN'`,
            [offer.id, offer.bidder_id, trade.id]
          );

          await tx.query(`update offers set status='ACCEPTED' where id=$1`, [offer.id]);

          await tx.query(
            `update offers set status='REJECTED'
             where trade_id=$1 and id<>$2 and status='PENDING'`,
            [trade.id, offer.id]
          );
        });
      } catch (e) {
        return interaction.reply({ content: `❌ Could not accept this offer: ${e?.message || "unknown error"}`, flags: EPHEMERAL });
      }

      const settings = await getGuildSettings(interaction.guild.id);
      const category = (await ensureTicketsCategory(interaction.guild, settings)).channel;
      const channelName = `trade-${safeShort(trade.id)}`;

      const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
      if (!me) return interaction.reply({ content: "❌ Bot member not resolved. Check permissions.", flags: EPHEMERAL });

      const ticket = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: trade.creator_id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
          {
            id: offer.bidder_id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
          {
            id: me.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ManageChannels,
              PermissionsBitField.Flags.ReadMessageHistory,
              PermissionsBitField.Flags.ManageMessages,
            ],
          },
        ],
      });

      await query(`update trades set ticket_channel_id=$1, updated_at=now() where id=$2`, [ticket.id, trade.id]);
      await updateTradePostStatusByTrade(interaction.guild, trade, "🟡 ACCEPTED", true);

      const creatorName = await resolveUsername(interaction.guild, trade.creator_id);
      const acceptorName = await resolveUsername(interaction.guild, offer.bidder_id);

      const summary = new EmbedBuilder()
        .setTitle("Trade Ticket")
        .setDescription("Work out the exchange details. When finished, each person press **✅ I completed**.")
        .addFields(
          { name: "Participants", value: `${creatorName} ↔ ${acceptorName}` },
          { name: "Have / Offer", value: truncate(trade.have_text, 1024) },
          { name: "Want", value: truncate(trade.want_text, 1024) },
          { name: "Accepted offer — Offers", value: truncate(offer.offer_text, 1024) },
          { name: "Accepted offer — Wants", value: truncate(offer.request_text, 1024) }
        );

      await ticket.send({
        content: `<@${trade.creator_id}> <@${offer.bidder_id}>`,
        embeds: [summary],
        components: [ticketActionRow(trade.id)],
      });

      await auditLog({ guildId: interaction.guild.id, actorId: interaction.user.id, action: "OFFER_ACCEPTED", tradeId: trade.id, channelId: ticket.id });
      await postOps(interaction.guild, settings, `🟡 Offer accepted: \`${safeShort(trade.id)}\` → ticket <#${ticket.id}>`);

      if (settings.dm_notifications) {
        await dmUser(trade.creator_id, `🟡 Offer accepted on trade ${safeShort(trade.id)} in **${interaction.guild.name}**. Ticket: <#${ticket.id}>`);
        await dmUser(offer.bidder_id, `🟡 Your offer was accepted for trade ${safeShort(trade.id)} in **${interaction.guild.name}**. Ticket: <#${ticket.id}>`);
      }

      return interaction.reply({ content: `✅ Offer accepted. Ticket created: <#${ticket.id}>`, flags: EPHEMERAL });
    }

    // Ticket: "I completed"
    if (interaction.isButton() && interaction.customId.startsWith("ticket_done:")) {
      const tradeId = interaction.customId.split(":")[1];
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }
      if (trade.status !== "ACCEPTED") {
        return interaction.reply({ content: `This trade is not ACCEPTED (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      const isCreator = interaction.user.id === trade.creator_id;
      const isAcceptor = interaction.user.id === trade.acceptor_id;
      if (!isCreator && !isAcceptor) {
        return interaction.reply({ content: "Only participants can mark completed.", flags: EPHEMERAL });
      }

      if (isCreator) await query(`update trades set creator_done=true, updated_at=now() where id=$1`, [tradeId]);
      if (isAcceptor) await query(`update trades set acceptor_done=true, updated_at=now() where id=$1`, [tradeId]);

      const t2 = (await query(`select creator_done, acceptor_done from trades where id=$1`, [tradeId])).rows[0];
      const statusLine = `Completion status: creator=${t2.creator_done ? "✅" : "⏳"} | acceptor=${t2.acceptor_done ? "✅" : "⏳"}`;

      if (t2.creator_done && t2.acceptor_done) {
        await query(
          `update trades
           set status='COMPLETED', completed_at=now(), updated_at=now(),
               review_deadline_at = now() + ($2 || ' hours')::interval
           where id=$1`,
          [tradeId, String(REVIEW_WINDOW_HOURS)]
        );

        await postTradeHistory(interaction.guild, tradeId);

        const fresh = (await query(`select * from trades where id=$1`, [tradeId])).rows[0];

        try {
          if (interaction.channel?.isTextBased()) {
            await interaction.channel.send({
              content: `📝 Trade completed. Leave your reviews (you have **${REVIEW_WINDOW_HOURS} hours**). When both reviews are submitted, this ticket will be archived automatically.`,
              components: [reviewButtonsRow(fresh)],
            });
          }
        } catch {
          // ignore
        }

        const settings = await getGuildSettings(interaction.guild.id);
        await auditLog({
          guildId: interaction.guild.id,
          actorId: interaction.user.id,
          action: "TRADE_COMPLETED",
          tradeId,
          channelId: interaction.channel?.id || null,
        });
        await postOps(interaction.guild, settings, `✅ Trade completed: \`${safeShort(tradeId)}\``);

        if (settings.dm_notifications) {
          const msg = `✅ Trade completed ${safeShort(tradeId)} in **${interaction.guild.name}**.\nPlease leave your review within ${REVIEW_WINDOW_HOURS}h.`;
          if (trade.creator_id) await dmUser(trade.creator_id, msg);
          if (trade.acceptor_id) await dmUser(trade.acceptor_id, msg);
        }

        return interaction.reply({ content: `🎉 Trade marked as COMPLETED.\n${statusLine}`, flags: EPHEMERAL });
      }

      return interaction.reply({ content: `✅ Marked.\n${statusLine}`, flags: EPHEMERAL });
    }

    // Ticket: Dispute
    if (interaction.isButton() && interaction.customId.startsWith("ticket_dispute:")) {
      const tradeId = interaction.customId.split(":")[1];
      if (!interaction.guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL });

      const result = await markDisputedAndEscalate(interaction.guild, tradeId, interaction.user.id, interaction.channel);
      return interaction.reply({ content: result.msg, flags: EPHEMERAL });
    }

    // Dispute: Resolve (mods) -> modal
    if (interaction.isButton() && interaction.customId.startsWith("dispute_resolve:")) {
      if (!interaction.guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL });

      const settings = await getGuildSettings(interaction.guild.id);
      if (!isModerator(interaction.member, settings)) {
        return interaction.reply({ content: "❌ Only moderators can resolve disputes.", flags: EPHEMERAL });
      }

      const tradeId = interaction.customId.split(":")[1];

      const modal = new ModalBuilder().setCustomId(`dispute_resolve_submit:${tradeId}`).setTitle("Resolve Dispute");

      const resultInput = new TextInputBuilder()
        .setCustomId("result")
        .setLabel("Result (COMPLETED / CANCELED / EXPIRED)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(10);

      const reasonInput = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason for closing")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(800);

      modal.addComponents(new ActionRowBuilder().addComponents(resultInput), new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
      return;
    }

    // Dispute: resolve submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith("dispute_resolve_submit:")) {
      if (!interaction.guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL });

      const settings = await getGuildSettings(interaction.guild.id);
      if (!isModerator(interaction.member, settings)) {
        return interaction.reply({ content: "❌ Only moderators can resolve disputes.", flags: EPHEMERAL });
      }

      const tradeId = interaction.customId.split(":")[1];
      const resultRaw = interaction.fields.getTextInputValue("result");
      const reason = (interaction.fields.getTextInputValue("reason") || "").trim();

      const result = normalizeDisputeResult(resultRaw);
      if (!result) return interaction.reply({ content: "❌ Invalid result. Use: COMPLETED, CANCELED, or EXPIRED.", flags: EPHEMERAL });
      if (!reason) return interaction.reply({ content: "❌ Reason is required.", flags: EPHEMERAL });

      const out = await resolveDisputeAndClose({
        guild: interaction.guild,
        tradeId,
        moderatorId: interaction.user.id,
        result,
        reason,
        channel: interaction.channel,
      });

      return interaction.reply({ content: out.msg, flags: EPHEMERAL });
    }

    // Dispute: Add proof/note -> modal
    if (interaction.isButton() && interaction.customId.startsWith("proof_add:")) {
      const [, tradeId, kind] = interaction.customId.split(":");
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const isParticipant = interaction.user.id === trade.creator_id || interaction.user.id === trade.acceptor_id;
      const settings = await getGuildSettings(interaction.guild.id);
      const mod = isModerator(interaction.member, settings);

      if (!isParticipant && !mod) return interaction.reply({ content: "Only participants or moderators can add proofs.", flags: EPHEMERAL });

      const modal = new ModalBuilder().setCustomId(`proof_submit:${tradeId}:${kind}`).setTitle(kind === "NOTE" ? "Add note" : "Add proof");

      const contentInput = new TextInputBuilder()
        .setCustomId("content")
        .setLabel(kind === "NOTE" ? "Note (text)" : "Proof (link / message link / description)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(900);

      modal.addComponents(new ActionRowBuilder().addComponents(contentInput));
      await interaction.showModal(modal);
      return;
    }

    // Dispute: proof submit
    if (interaction.isModalSubmit() && interaction.customId.startsWith("proof_submit:")) {
      const [, tradeId, kind] = interaction.customId.split(":");
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const content = (interaction.fields.getTextInputValue("content") || "").trim();
      if (!content) return interaction.reply({ content: "Content required.", flags: EPHEMERAL });

      await addProof({
        tradeId,
        guildId: interaction.guild.id,
        channelId: interaction.channel?.id || null,
        userId: interaction.user.id,
        kind: kind === "NOTE" ? "NOTE" : "PROOF",
        content,
      });

      const settings = await getGuildSettings(interaction.guild.id);
      await auditLog({
        guildId: interaction.guild.id,
        actorId: interaction.user.id,
        action: "PROOF_ADDED",
        tradeId,
        channelId: interaction.channel?.id || null,
        meta: { kind, content: truncate(content, 120) },
      });

      await postOps(interaction.guild, settings, `📎 Proof/Note added on \`${safeShort(tradeId)}\` by <@${interaction.user.id}> (${kind})`);

      return interaction.reply({ content: "✅ Saved.", flags: EPHEMERAL });
    }

    // Dispute: view proofs
    if (interaction.isButton() && interaction.customId.startsWith("proof_view:")) {
      const tradeId = interaction.customId.split(":")[1];
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const settings = await getGuildSettings(interaction.guild.id);
      const isParticipant = interaction.user.id === trade.creator_id || interaction.user.id === trade.acceptor_id;
      const mod = isModerator(interaction.member, settings);
      if (!isParticipant && !mod) {
        return interaction.reply({ content: "Only participants or moderators can view proofs.", flags: EPHEMERAL });
      }

      const rows = await listProofs(tradeId, 10);
      const embed = new EmbedBuilder().setTitle(`👀 Proofs/Notes — ${safeShort(tradeId)}`);

      if (!rows.length) {
        embed.setDescription("No proofs yet.");
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      const lines = [];
      for (const r of rows) {
        lines.push(`• **${r.kind}** by <@${r.user_id}> — ${truncate(r.content, 180)}`);
      }
      embed.setDescription(lines.join("\n").slice(0, 4000));
      return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    }

    // =========================
    // Reviews
    // =========================
    if (interaction.isButton() && interaction.customId.startsWith("review_open:")) {
      const [, tradeId, toUserId] = interaction.customId.split(":");
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const fromUserId = interaction.user.id;
      const isParticipant = fromUserId === trade.creator_id || fromUserId === trade.acceptor_id;
      if (!isParticipant) return interaction.reply({ content: "Only participants can leave a review.", flags: EPHEMERAL });

      if (trade.status !== "COMPLETED") {
        return interaction.reply({ content: "Reviews are only available after the trade is COMPLETED.", flags: EPHEMERAL });
      }

      if (trade.review_deadline_at) {
        const dl = new Date(trade.review_deadline_at).getTime();
        if (Date.now() > dl) return interaction.reply({ content: "The review window has expired.", flags: EPHEMERAL });
      }

      if (String(toUserId) === String(fromUserId)) return interaction.reply({ content: "You can't review yourself.", flags: EPHEMERAL });

      const validTarget =
        (fromUserId === trade.creator_id && String(toUserId) === String(trade.acceptor_id)) ||
        (fromUserId === trade.acceptor_id && String(toUserId) === String(trade.creator_id));

      if (!validTarget) return interaction.reply({ content: "That review target doesn't match this trade.", flags: EPHEMERAL });

      const modal = new ModalBuilder().setCustomId(`review_submit:${tradeId}:${toUserId}`).setTitle("Leave a review (1–5 stars)");

      const stars = new TextInputBuilder()
        .setCustomId("stars")
        .setLabel("Stars (1 to 5)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(1);

      const comment = new TextInputBuilder()
        .setCustomId("comment")
        .setLabel("Comment (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(800);

      modal.addComponents(new ActionRowBuilder().addComponents(stars), new ActionRowBuilder().addComponents(comment));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("review_submit:")) {
      const [, tradeId, toUserId] = interaction.customId.split(":");
      const trade = await getTradeById(tradeId);
      if (!trade) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const fromUserId = interaction.user.id;
      const isParticipant = fromUserId === trade.creator_id || fromUserId === trade.acceptor_id;
      if (!isParticipant) return interaction.reply({ content: "Only participants can leave a review.", flags: EPHEMERAL });

      if (trade.status !== "COMPLETED") {
        return interaction.reply({ content: "Reviews are only available after the trade is COMPLETED.", flags: EPHEMERAL });
      }

      if (trade.review_deadline_at) {
        const dl = new Date(trade.review_deadline_at).getTime();
        if (Date.now() > dl) return interaction.reply({ content: "The review window has expired.", flags: EPHEMERAL });
      }

      const starsRaw = interaction.fields.getTextInputValue("stars").trim();
      const stars = Number(starsRaw);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
        return interaction.reply({ content: "Stars must be a number from 1 to 5.", flags: EPHEMERAL });
      }

      const comment = interaction.fields.getTextInputValue("comment")?.trim() || null;

      try {
        await query(
          `insert into reviews (trade_id, from_user_id, to_user_id, stars, comment, created_at)
           values ($1,$2,$3,$4,$5, now())`,
          [tradeId, fromUserId, toUserId, stars, comment]
        );
      } catch {
        return interaction.reply({ content: "You already left a review for this trade.", flags: EPHEMERAL });
      }

      const settings = await getGuildSettings(interaction.guild.id);
      await auditLog({
        guildId: interaction.guild.id,
        actorId: interaction.user.id,
        action: "REVIEW_SUBMITTED",
        tradeId,
        channelId: interaction.channel?.id || null,
        meta: { toUserId, stars },
      });

      await postOps(interaction.guild, settings, `⭐ Review submitted on \`${safeShort(tradeId)}\` by <@${interaction.user.id}> → <@${toUserId}> (${stars}/5)`);

      const done = await bothReviewsSubmitted(tradeId);
      if (done) await archiveAndLockTicket(interaction.guild, tradeId, "both reviews submitted");

      return interaction.reply({ content: "✅ Review saved. Thanks!", flags: EPHEMERAL });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "❌ An error occurred. Check the console.", flags: EPHEMERAL });
      } catch {
        // ignore
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
