import "dotenv/config";
import {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Configure this bot for this server (admins only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName("view").setDescription("View current settings for this server"))
  .addSubcommand((s) =>
    s
      .setName("apply")
      .setDescription("Apply settings (and auto-create categories/channels)")
      .addRoleOption((o) => o.setName("mod_role").setDescription("Moderator role (optional)"))
      .addStringOption((o) => o.setName("tickets_category").setDescription("Tickets category name"))
      .addStringOption((o) => o.setName("disputes_category").setDescription("Disputes category name"))
      .addStringOption((o) => o.setName("closed_category").setDescription("Closed tickets category name"))
      .addStringOption((o) => o.setName("history_channel").setDescription("History channel name"))
      .addStringOption((o) => o.setName("ops_channel").setDescription("Ops channel name (mods only)"))
      .addBooleanOption((o) => o.setName("dm_notifications").setDescription("Enable DM notifications"))
  )
  .addSubcommand((s) => s.setName("reset").setDescription("Reset this server to default settings (from .env)"));

const tradeCommand = new SlashCommandBuilder()
  .setName("trade")
  .setDescription("ARC Raiders marketplace")
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Create a trade")
      .addStringOption((o) => o.setName("have").setDescription("What you have / offer").setRequired(true))
      .addStringOption((o) => o.setName("want").setDescription("What you want (or 'open to offers')").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setDescription("List open trades (with optional search)")
      .addStringOption((o) => o.setName("q").setDescription("Search in have/want text"))
      .addUserOption((o) => o.setName("user").setDescription("Filter by creator"))
      .addIntegerOption((o) => o.setName("limit").setDescription("Max results (1-25)"))
  )
  .addSubcommand((s) =>
    s
      .setName("my")
      .setDescription("Show my recent trades")
      .addIntegerOption((o) => o.setName("limit").setDescription("Max results (1-25)"))
  )
  .addSubcommand((s) =>
    s
      .setName("info")
      .setDescription("Show trade details by ID")
      .addStringOption((o) => o.setName("id").setDescription("Trade UUID").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("bump")
      .setDescription("Repost the trade embed (cooldown recommended)")
      .addStringOption((o) => o.setName("id").setDescription("Trade UUID").setRequired(true))
  );

const offerCommand = new SlashCommandBuilder()
  .setName("offer")
  .setDescription("Offers utilities")
  .addSubcommand((s) =>
    s
      .setName("my")
      .setDescription("Show my pending offers")
      .addIntegerOption((o) => o.setName("limit").setDescription("Max results (1-25)"))
  );

const repCommand = new SlashCommandBuilder()
  .setName("rep")
  .setDescription("View a user's reputation (stars, badges, reviews)")
  .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true));

const marketCommand = new SlashCommandBuilder()
  .setName("market")
  .setDescription("Marketplace dashboard (in-Discord)")
  .addSubcommand((s) =>
    s
      .setName("stats")
      .setDescription("Server stats (7d/30d)")
  )
  .addSubcommand((s) =>
    s
      .setName("top")
      .setDescription("Top traders")
      .addStringOption((o) =>
        o
          .setName("range")
          .setDescription("Ranking time range")
          .addChoices(
            { name: "7d", value: "7d" },
            { name: "30d", value: "30d" },
            { name: "all", value: "all" }
          )
      )
  );

const disputesCommand = new SlashCommandBuilder()
  .setName("disputes")
  .setDescription("Disputes queue and assignment (mods only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) => s.setName("queue").setDescription("Show disputes queue"))
  .addSubcommand((s) =>
    s
      .setName("assign")
      .setDescription("Assign a dispute to a moderator")
      .addStringOption((o) => o.setName("trade_id").setDescription("Trade UUID").setRequired(true))
      .addUserOption((o) => o.setName("mod").setDescription("Moderator user").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("unassign")
      .setDescription("Remove assignment")
      .addStringOption((o) => o.setName("trade_id").setDescription("Trade UUID").setRequired(true))
  );

const commands = [
  tradeCommand,
  offerCommand,
  repCommand,
  marketCommand,
  disputesCommand,
  setupCommand,
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const app = await rest.get(Routes.oauth2CurrentApplication());
  const appId = app.id;

  await rest.put(Routes.applicationCommands(appId), {
    body: commands.map((c) => c.toJSON()),
  });

  console.log("✅ Slash commands registered/updated globally (multi-server).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
