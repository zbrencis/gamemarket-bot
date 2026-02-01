import { EmbedBuilder } from "discord.js";

export function buildUserGuideEmbed() {
  return new EmbedBuilder()
    .setTitle("📘 Marketplace Bot — User Guide")
    .setDescription(
      "Use these commands to create trades, browse listings, and check reputation.\n" +
      "This bot is not an escrow — trades are user-to-user."
    )
    .addFields(
      {
        name: "🔁 Create a trade",
        value: "`/trade create have:<what you offer> want:<what you want>`",
        inline: false,
      },
      {
        name: "📋 Browse open trades",
        value: "`/trade list` (optional: `q`, `user`, `limit`)",
        inline: false,
      },
      {
        name: "🙋 Your recent trades",
        value: "`/trade my` (optional: `limit`)",
        inline: false,
      },
      {
        name: "🔎 Trade details",
        value: "`/trade info id:<trade uuid>`",
        inline: false,
      },
      {
        name: "🔼 Bump a trade",
        value: "`/trade bump id:<trade uuid>`",
        inline: false,
      },
      {
        name: "💼 Your pending offers",
        value: "`/offer my` (optional: `limit`)",
        inline: false,
      },
      {
        name: "⭐ Reputation",
        value: "`/rep user:<member>`",
        inline: false,
      },
      {
        name: "📊 Marketplace dashboard",
        value: "`/market stats`  •  `/market top range:(7d|30d|all)`",
        inline: false,
      }
    )
    .setFooter({ text: "Tip: use /trade info to copy the trade UUID." });
}

export function buildStaffGuideEmbed() {
  return new EmbedBuilder()
    .setTitle("🛡️ Marketplace Bot — Staff / Moderators")
    .setDescription(
      "Staff-only commands for setup and dispute handling.\n" +
      "Requires Manage Server permission (or configured mod role)."
    )
    .addFields(
      { name: "⚙️ View settings", value: "`/setup view`", inline: false },
      {
        name: "🧰 Apply setup",
        value:
          "`/setup apply`\n" +
          "Options:\n" +
          "• `mod_role` (optional)\n" +
          "• `tickets_category`\n" +
          "• `disputes_category`\n" +
          "• `closed_category`\n" +
          "• `history_channel`\n" +
          "• `ops_channel`\n" +
          "• `dm_notifications`",
        inline: false,
      },
      { name: "♻️ Reset settings", value: "`/setup reset`", inline: false },
      { name: "⚖️ Disputes queue", value: "`/disputes queue`", inline: false },
      {
        name: "👤 Assign dispute",
        value: "`/disputes assign trade_id:<trade uuid> mod:<moderator>`",
        inline: false,
      },
      {
        name: "🚫 Unassign dispute",
        value: "`/disputes unassign trade_id:<trade uuid>`",
        inline: false,
      }
    )
    .setFooter({ text: "Best practice: verify trade with /trade info before assigning disputes." });
}
