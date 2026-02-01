// index.js (multi-server: guild settings + /setup plug & play)
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
    const settings = await getGuildSettings(guild.id); // defaults si no hay DB
    await ensureGuildResources(guild, settings);
    console.log(`✅ Auto-setup done for guild: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error("❌ Auto-setup failed:", e?.message || e);
  }
});

// =========================
// Helpers
// =========================
function truncate(str, n = 1024) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 3) + "..." : str;
}

function cleanName(s, max = 90) {
  const out = String(s ?? "").trim();
  if (!out) return null;
  return out.length > max ? out.slice(0, max) : out;
}

async function getTradeByMessageId(messageId) {
  const res = await query(`select * from trades where message_id=$1`, [messageId]);
  return res.rowCount ? res.rows[0] : null;
}

async function resolveUsername(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName || member.user.username;
  } catch {
    return `User ${userId}`;
  }
}

async function ensureCategoryByName(guild, name) {
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return { channel: existing, created: false };

  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  return { channel: created, created: true };
}

async function ensureTextChannelByName(guild, name) {
  const lower = name.toLowerCase();
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === lower);
  if (existing) return { channel: existing, created: false };

  const created = await guild.channels.create({ name, type: ChannelType.GuildText });
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

// ✅ Plug & play: crea/asegura recursos al aplicar /setup
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

  return results;
}

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
    new ButtonBuilder().setCustomId(`review_open:${trade.id}:${trade.acceptor_id}`).setLabel("⭐ Review acceptor").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`review_open:${trade.id}:${trade.creator_id}`).setLabel("⭐ Review creator").setStyle(ButtonStyle.Secondary)
  );
}

function disputeResolveRow(tradeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dispute_resolve:${tradeId}`).setLabel("🧑‍⚖️ Resolve Dispute").setStyle(ButtonStyle.Primary)
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

  const completedAsCreator = await query(`select count(*)::int as c from trades where creator_id = $1 and status = 'COMPLETED'`, [userId]);
  const completedAsAcceptor = await query(`select count(*)::int as c from trades where acceptor_id = $1 and status = 'COMPLETED'`, [userId]);

  const avgStars = Number(agg.rows[0].avg_stars || 0);
  const reviewCount = Number(agg.rows[0].review_count || 0);
  const c1 = Number(completedAsCreator.rows[0].c || 0);
  const c2 = Number(completedAsAcceptor.rows[0].c || 0);

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
      } catch {}
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
// Ticket close rules (after reviews or 24h)
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

  return Number(rRes.rows[0].c || 0) >= 2;
}

// ✅ CLOSE: move to Closed Tickets, read-only, hide from participants
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
  } catch (e) {
    console.error("❌ setParent failed (close):", e?.code || e?.message || e);
  }

  // deny participants view
  try {
    if (trade.creator_id) await ch.permissionOverwrites.edit(trade.creator_id, { ViewChannel: false });
    if (trade.acceptor_id) await ch.permissionOverwrites.edit(trade.acceptor_id, { ViewChannel: false });
  } catch (e) {
    console.error("❌ overwrite deny participants failed:", e?.code || e?.message || e);
  }

  // read-only for everyone
  try {
    await ch.permissionOverwrites.edit(guild.roles.everyone.id, { SendMessages: false, AddReactions: false });
  } catch (e) {
    console.error("❌ overwrite everyone read-only failed:", e?.code || e?.message || e);
  }

  // ensure bot can still operate
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    await ch.permissionOverwrites.edit(me.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      ManageChannels: true,
      ManageMessages: true,
    });
  } catch (e) {
    console.error("❌ overwrite bot allow failed:", e?.code || e?.message || e);
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
    } catch {}
  }

  try {
    const safeId = String(tradeId).slice(0, 8);
    await ch.setName(`closed-${safeId}`);
  } catch {}

  if (ch.isTextBased()) {
    await ch.send(`🔒 Ticket archived (${reason}). This channel is now read-only.`).catch(() => null);
  }

  await query(`update trades set ticket_closed_at=now(), updated_at=now() where id=$1`, [tradeId]);
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
    await archiveAndLockTicket(guild, row.id, "24h deadline reached");
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
// Dispute handling
// =========================
async function markDisputedAndEscalate(guild, tradeId, triggeredByUserId, currentChannel) {
  const tRes = await query(`select * from trades where id=$1`, [tradeId]);
  if (!tRes.rowCount) return { ok: false, msg: "Trade not found." };
  const trade = tRes.rows[0];

  if (String(trade.guild_id) !== String(guild.id)) return { ok: false, msg: "Guild mismatch." };

  const isParticipant = triggeredByUserId === trade.creator_id || triggeredByUserId === trade.acceptor_id;
  if (!isParticipant) return { ok: false, msg: "Only participants can open a dispute." };

  const settings = await getGuildSettings(guild.id);

  await query(`update trades set status='DISPUTED', updated_at=now() where id=$1`, [tradeId]);
  await updateTradePostStatusByTrade(guild, trade, "⚠️ DISPUTED", true);

  const disputesCat = (await ensureDisputesCategory(guild, settings)).channel;

  if (currentChannel && currentChannel.type === ChannelType.GuildText) {
    try {
      await currentChannel.setParent(disputesCat.id, { lockPermissions: false });
    } catch (e) {
      console.error("❌ setParent failed (dispute):", e?.code || e?.message || e);
    }

    // ensure bot access
    try {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      await currentChannel.permissionOverwrites.edit(me.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageChannels: true,
        ManageMessages: true,
      });
    } catch {}

    // mods access
    if (settings.mod_role_id) {
      try {
        await currentChannel.permissionOverwrites.edit(settings.mod_role_id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          ManageMessages: true,
        });
      } catch {}
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
    } catch {}
  }

  if (currentChannel?.isTextBased()) {
    const ping = settings.mod_role_id ? `<@&${settings.mod_role_id}> ` : "";
    const embed = new EmbedBuilder()
      .setTitle("⚠️ Dispute Opened")
      .setDescription(
        `Dispute opened for Trade **${String(tradeId).slice(0, 8)}**.\n\n` +
          `📌 Please provide screenshots / proof.\n` +
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
        components: [disputeResolveRow(tradeId)],
      })
      .catch(() => null);
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
  const tRes = await query(`select * from trades where id=$1`, [tradeId]);
  if (!tRes.rowCount) return { ok: false, msg: "Trade not found." };
  const trade = tRes.rows[0];

  if (String(trade.guild_id) !== String(guild.id)) return { ok: false, msg: "Guild mismatch." };

  await query(`update trades set status=$2, updated_at=now() where id=$1`, [tradeId, result]);
  await updateTradePostStatusByTrade(guild, trade, labelForFinalStatus(result), true);

  if (result === "COMPLETED") {
    await postTradeHistory(guild, tradeId);
  }

  await tryInsertDisputeLog({
    tradeId,
    guildId: guild.id,
    channelId: channel?.id || trade.ticket_channel_id || null,
    moderatorId,
    result,
    reason,
  });

  if (channel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setTitle("🧑‍⚖️ Dispute Resolved")
      .addFields(
        { name: "Result", value: result, inline: true },
        { name: "Moderator", value: `<@${moderatorId}>`, inline: true },
        { name: "Reason", value: truncate(reason || "—", 1024) }
      )
      .setFooter({ text: `Trade ID: ${String(tradeId).slice(0, 8)}` });

    await channel.send({ embeds: [embed] }).catch(() => null);
  }

  await archiveAndLockTicket(guild, tradeId, `dispute resolved: ${result}`);
  return { ok: true, msg: `✅ Dispute resolved as ${result} and ticket closed.` };
}

// =========================
// Main interaction handler
// =========================
client.on("interactionCreate", async (interaction) => {
  try {
    // =========================
    // /setup view|apply|reset (admins only)
    // =========================
    if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
      if (!interaction.guild) return interaction.reply({ content: "This command only works inside a server.", flags: EPHEMERAL });
      if (!isSetupAdmin(interaction.member)) return interaction.reply({ content: "❌ Only admins / Manage Server can run /setup.", flags: EPHEMERAL });

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
            { name: "history_channel_name", value: s.history_channel_name }
          );
        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      if (sub === "reset") {
        const s = await resetGuildSettings(interaction.guild.id);
        // plug & play: también asegura recursos con defaults
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
            {
              name: "resources",
              value: created
                .map((r) => `• ${r.label}: ${r.created ? "created" : "exists"} (${r.channel.name})`)
                .join("\n")
                .slice(0, 1024),
            }
          );

        return interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      }

      // apply
      if (sub === "apply") {
        const modRole = interaction.options.getRole("mod_role");
        const ticketsCat = interaction.options.getString("tickets_category");
        const disputesCat = interaction.options.getString("disputes_category");
        const closedCat = interaction.options.getString("closed_category");
        const historyChan = interaction.options.getString("history_channel");

        const patch = {};
        if (modRole) patch.mod_role_id = modRole.id;
        if (ticketsCat != null) patch.tickets_category_name = cleanName(ticketsCat, 90);
        if (disputesCat != null) patch.disputes_category_name = cleanName(disputesCat, 90);
        if (closedCat != null) patch.closed_category_name = cleanName(closedCat, 90);
        if (historyChan != null) patch.history_channel_name = cleanName(historyChan, 90);

        const updated = await upsertGuildSettings(interaction.guild.id, patch);

        // ✅ plug & play: ensure resources now
        const ensured = await ensureGuildResources(interaction.guild, updated);

        const embed = new EmbedBuilder()
          .setTitle("✅ Settings Applied (Plug & Play)")
          .setDescription("Settings saved and required categories/channels ensured.")
          .addFields(
            { name: "mod_role_id", value: updated.mod_role_id ? `<@&${updated.mod_role_id}> (${updated.mod_role_id})` : "—" },
            { name: "tickets_category_name", value: updated.tickets_category_name },
            { name: "disputes_category_name", value: updated.disputes_category_name },
            { name: "closed_category_name", value: updated.closed_category_name },
            { name: "history_channel_name", value: updated.history_channel_name },
            {
              name: "resources",
              value: ensured
                .map((r) => `• ${r.label}: ${r.created ? "created" : "exists"} (${r.channel.name})`)
                .join("\n")
                .slice(0, 1024),
            }
          );

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

      await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      return;
    }

    // =========================
    // /trade create
    // =========================
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "trade" && interaction.options.getSubcommand() === "create") {
        const haveText = interaction.options.getString("have", true);
        const wantText = interaction.options.getString("want", true);

        await interaction.reply({ content: "Creating trade…", flags: EPHEMERAL });

        const channel = interaction.channel;
        if (!channel) return;

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

        await interaction.editReply({ content: "✅ Trade created in the channel." });
        return;
      }
    }

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

      const tRes = await query(`select * from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      const trade = tRes.rows[0];
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

      await interaction.reply({
        content: "✅ Offer sent. You can withdraw it anytime using **🗑️ Withdraw my offer**.",
        flags: EPHEMERAL,
      });
      return;
    }

    // View offers -> Select menu
    if (interaction.isButton() && interaction.customId === "trade_view_offers") {
      const trade = await getTradeByMessageId(interaction.message.id);
      if (!trade) return interaction.reply({ content: "I couldn't find this trade in the database.", flags: EPHEMERAL });

      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can view offers.", flags: EPHEMERAL });
      }
      if (!interaction.guild) {
        return interaction.reply({ content: "This button only works inside a server.", flags: EPHEMERAL });
      }

      const oRes = await query(
        `select id, bidder_id, offer_text
         from offers
         where trade_id=$1 and status='PENDING'
         order by created_at asc
         limit 25`,
        [trade.id]
      );

      if (!oRes.rowCount) {
        return interaction.reply({ content: "No pending offers yet.", flags: EPHEMERAL });
      }

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

      await interaction.reply({
        content: "📩 Pending offers (pick one):",
        components: [new ActionRowBuilder().addComponents(select)],
        flags: EPHEMERAL,
      });
      return;
    }

    // Pick offer -> details + Accept/Reject
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("offer_pick:")) {
      const tradeId = interaction.customId.split(":")[1];
      const offerId = interaction.values[0];

      const tRes = await query(`select * from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      const trade = tRes.rows[0];
      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can do this.", flags: EPHEMERAL });
      }
      if (!interaction.guild) {
        return interaction.reply({ content: "This only works inside a server.", flags: EPHEMERAL });
      }

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

      await interaction.reply({ embeds: [embed], components: [row], flags: EPHEMERAL });
      return;
    }

    // Reject offer
    if (interaction.isButton() && interaction.customId.startsWith("offer_reject:")) {
      const offerId = interaction.customId.split(":")[1];

      const oRes = await query(`select trade_id from offers where id=$1`, [offerId]);
      if (!oRes.rowCount) return interaction.reply({ content: "Offer not found.", flags: EPHEMERAL });

      const tradeId = oRes.rows[0].trade_id;
      const tRes = await query(`select creator_id, status from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });

      const trade = tRes.rows[0];
      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can reject offers.", flags: EPHEMERAL });
      }
      if (trade.status !== "OPEN") {
        return interaction.reply({ content: `This trade is not OPEN anymore (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      await query(`update offers set status='REJECTED' where id=$1 and status='PENDING'`, [offerId]);
      await interaction.reply({ content: "❌ Offer rejected.", flags: EPHEMERAL });
      return;
    }

    // Accept offer -> create ticket (transaction)
    if (interaction.isButton() && interaction.customId.startsWith("offer_accept:")) {
      const offerId = interaction.customId.split(":")[1];

      const oRes = await query(`select * from offers where id=$1`, [offerId]);
      if (!oRes.rowCount) return interaction.reply({ content: "Offer not found.", flags: EPHEMERAL });
      const offer = oRes.rows[0];

      const tRes = await query(`select * from trades where id=$1`, [offer.trade_id]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      const trade = tRes.rows[0];

      if (!interaction.guild) return interaction.reply({ content: "This only works inside a server.", flags: EPHEMERAL });
      if (trade.creator_id !== interaction.user.id) {
        return interaction.reply({ content: "Only the creator can accept offers.", flags: EPHEMERAL });
      }
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
      const channelName = `trade-${String(trade.id).slice(0, 8)}`;

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
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
          },
          {
            id: offer.bidder_id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory],
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

      await interaction.reply({ content: `✅ Offer accepted. Ticket created: <#${ticket.id}>`, flags: EPHEMERAL });
      return;
    }

    // Ticket: "I completed"
    if (interaction.isButton() && interaction.customId.startsWith("ticket_done:")) {
      const tradeId = interaction.customId.split(":")[1];

      const tRes = await query(`select * from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      const trade = tRes.rows[0];

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      if (trade.status !== "ACCEPTED") {
        return interaction.reply({ content: `This trade is not ACCEPTED (status: ${trade.status}).`, flags: EPHEMERAL });
      }

      const isCreator = interaction.user.id === trade.creator_id;
      const isAcceptor = interaction.user.id === trade.acceptor_id;
      if (!isCreator && !isAcceptor) return interaction.reply({ content: "Only participants can mark completed.", flags: EPHEMERAL });

      if (isCreator) await query(`update trades set creator_done=true, updated_at=now() where id=$1`, [tradeId]);
      if (isAcceptor) await query(`update trades set acceptor_done=true, updated_at=now() where id=$1`, [tradeId]);

      const t2 = (await query(`select creator_done, acceptor_done from trades where id=$1`, [tradeId])).rows[0];
      const statusLine = `Completion status: creator=${t2.creator_done ? "✅" : "⏳"} | acceptor=${t2.acceptor_done ? "✅" : "⏳"}`;

      if (t2.creator_done && t2.acceptor_done) {
        await query(
          `update trades
           set status='COMPLETED', completed_at=now(), updated_at=now(),
               review_deadline_at = now() + interval '24 hours'
           where id=$1`,
          [tradeId]
        );

        await postTradeHistory(interaction.guild, tradeId);

        const fresh = (await query(`select * from trades where id=$1`, [tradeId])).rows[0];

        try {
          if (interaction.channel?.isTextBased()) {
            await interaction.channel.send({
              content:
                "📝 Trade completed. Leave your reviews (you have **24 hours**). When both reviews are submitted, this ticket will be archived automatically.",
              components: [reviewButtonsRow(fresh)],
            });
          }
        } catch {}

        await interaction.reply({ content: `🎉 Trade marked as COMPLETED.\n${statusLine}`, flags: EPHEMERAL });
        return;
      }

      await interaction.reply({ content: `✅ Marked.\n${statusLine}`, flags: EPHEMERAL });
      return;
    }

    // Ticket: Dispute
    if (interaction.isButton() && interaction.customId.startsWith("ticket_dispute:")) {
      const tradeId = interaction.customId.split(":")[1];
      if (!interaction.guild) return interaction.reply({ content: "This only works in a server.", flags: EPHEMERAL });

      const result = await markDisputedAndEscalate(interaction.guild, tradeId, interaction.user.id, interaction.channel);
      return interaction.reply({ content: result.msg, flags: EPHEMERAL });
    }

    // Mod Resolve Dispute -> open modal
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

    // Modal submit (resolve dispute)
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

    // Button: open review modal
    if (interaction.isButton() && interaction.customId.startsWith("review_open:")) {
      const [, tradeId, toUserId] = interaction.customId.split(":");

      const tRes = await query(`select * from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      const trade = tRes.rows[0];

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const fromUserId = interaction.user.id;
      const isParticipant = fromUserId === trade.creator_id || fromUserId === trade.acceptor_id;
      if (!isParticipant) return interaction.reply({ content: "Only participants can leave a review.", flags: EPHEMERAL });

      if (trade.status !== "COMPLETED") return interaction.reply({ content: "Reviews are only available after the trade is COMPLETED.", flags: EPHEMERAL });

      if (trade.review_deadline_at) {
        const dl = new Date(trade.review_deadline_at).getTime();
        if (Date.now() > dl) return interaction.reply({ content: "The review window (24h) has expired.", flags: EPHEMERAL });
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

    // Review modal submit (close ticket after both reviews)
    if (interaction.isModalSubmit() && interaction.customId.startsWith("review_submit:")) {
      const [, tradeId, toUserId] = interaction.customId.split(":");

      const tRes = await query(`select * from trades where id=$1`, [tradeId]);
      if (!tRes.rowCount) return interaction.reply({ content: "Trade not found.", flags: EPHEMERAL });
      const trade = tRes.rows[0];

      if (!interaction.guild || String(trade.guild_id) !== String(interaction.guild.id)) {
        return interaction.reply({ content: "Guild mismatch.", flags: EPHEMERAL });
      }

      const fromUserId = interaction.user.id;
      const isParticipant = fromUserId === trade.creator_id || fromUserId === trade.acceptor_id;
      if (!isParticipant) return interaction.reply({ content: "Only participants can leave a review.", flags: EPHEMERAL });

      if (trade.status !== "COMPLETED") return interaction.reply({ content: "Reviews are only available after the trade is COMPLETED.", flags: EPHEMERAL });

      if (trade.review_deadline_at) {
        const dl = new Date(trade.review_deadline_at).getTime();
        if (Date.now() > dl) return interaction.reply({ content: "The review window (24h) has expired.", flags: EPHEMERAL });
      }

      const starsRaw = interaction.fields.getTextInputValue("stars").trim();
      const stars = Number(starsRaw);
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return interaction.reply({ content: "Stars must be a number from 1 to 5.", flags: EPHEMERAL });

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

      if (interaction.guild) {
        const done = await bothReviewsSubmitted(tradeId);
        if (done) await archiveAndLockTicket(interaction.guild, tradeId, "both reviews submitted");
      }

      await interaction.reply({ content: "✅ Review saved. Thanks!", flags: EPHEMERAL });
      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "❌ An error occurred. Check the console.", flags: EPHEMERAL });
      } catch {}
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
