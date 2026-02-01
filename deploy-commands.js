// deploy-commands.js
import "dotenv/config";
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

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
      .addStringOption((o) => o.setName("tickets_category").setDescription("Tickets category name (e.g., Trade Tickets)"))
      .addStringOption((o) => o.setName("disputes_category").setDescription("Disputes category name"))
      .addStringOption((o) => o.setName("closed_category").setDescription("Closed tickets category name"))
      .addStringOption((o) => o.setName("history_channel").setDescription("History channel name (e.g., trade-history)"))
  )
  .addSubcommand((s) => s.setName("reset").setDescription("Reset this server to default settings (from .env)"));

const commands = [
  new SlashCommandBuilder()
    .setName("trade")
    .setDescription("ARC Raiders marketplace")
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a trade")
        .addStringOption((o) => o.setName("have").setDescription("What you have / offer").setRequired(true))
        .addStringOption((o) => o.setName("want").setDescription("What you want (or 'open to offers')").setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName("rep")
    .setDescription("View a user's reputation (stars, badges, reviews)")
    .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),

  setupCommand,
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const app = await rest.get(Routes.oauth2CurrentApplication());
  const appId = app.id;

  // ✅ GLOBAL (multi-server)
  await rest.put(Routes.applicationCommands(appId), {
    body: commands.map((c) => c.toJSON()),
  });

  console.log("✅ Slash commands registered/updated globally (multi-server).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
