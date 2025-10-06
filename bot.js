// bot.js
import express from "express";
import cors from "cors";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// ---------- Mongoose models ----------
const { Schema } = mongoose;

const MessageSchema = new Schema({
  from: { type: String, required: true }, // "player" or "admin"
  text: { type: String, required: true },
  time: { type: Date, default: Date.now }
}, { _id: false });

const ThreadSchema = new Schema({
  playerId: { type: String, required: true, unique: true },
  messages: { type: [MessageSchema], default: [] },
  hasNew: { type: Boolean, default: false }
}, { timestamps: true });

const Thread = mongoose.model("Thread", ThreadSchema);

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Utility to upsert thread and push message
async function pushMessage(playerId, from, text) {
  if (!playerId) return;
  const update = {
    $push: { messages: { from, text, time: new Date() } }
  };
  if (from === "admin") update.$set = { hasNew: true };
  const opt = { upsert: true, new: true, setDefaultsOnInsert: true };
  return Thread.findOneAndUpdate({ playerId }, update, opt).exec();
}

// ---------- Discord events ----------
client.once("ready", () => {
  console.log(`🤖 Bot ${client.user.tag} ready`);
});

client.on("error", (err) => console.error("Discord client error:", err));
client.on("shardError", (err) => console.error("Shard error:", err));
client.on("warn", (msg) => console.warn("Discord warn:", msg));

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Case: admin replies to a player message (Reply action)
    if (message.reference) {
      const replied = await message.channel.messages.fetch(message.reference.messageId);
      const match = replied.content.match(/\*\*(.*?)\*\*/); // expects "**playerId**: text"
      if (match) {
        const playerId = match[1];
        const text = message.content.trim();
        await pushMessage(playerId, "admin", text);
        console.log(`Admin -> ${playerId}: ${text}`);
      }
      return;
    }

    // Case: admin types "PLAYERID: message" in support channel
    if (message.channel.id === process.env.CHANNEL_ID) {
      const [playerIdRaw, ...parts] = message.content.split(":");
      const text = parts.join(":").trim();
      const playerId = (playerIdRaw || "").trim();
      if (playerId && text) {
        await pushMessage(playerId, "admin", text);
        console.log(`Admin -> ${playerId}: ${text}`);
      }
    }
  } catch (e) {
    console.error("Error processing messageCreate:", e);
  }
});

// ---------- Express endpoints ----------
app.get("/", (req, res) => res.send("✅ Support Chat Bot is running"));

app.post("/sendMessage", async (req, res) => {
  try {
    const { playerId, text } = req.body;
    if (!playerId || !text) return res.status(400).json({ error: "playerId and text required" });

    // send to discord channel
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    await channel.send(`**${playerId}**: ${text}`);

    // save to DB
    await pushMessage(playerId, "player", text);
    return res.json({ success: true });
  } catch (err) {
    console.error("sendMessage error:", err);
    return res.status(500).json({ error: "send failed" });
  }
});

app.get("/getMessages/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const thread = await Thread.findOne({ playerId }).lean().exec();
    return res.json(thread?.messages || []);
  } catch (err) {
    console.error("getMessages error:", err);
    return res.status(500).json([]);
  }
});

app.get("/checkNewMessages/:playerId", async (req, res) => {
  try {
    const { playerId } = req.params;
    const thread = await Thread.findOne({ playerId }).lean().exec();
    return res.json({ hasNew: !!thread?.hasNew });
  } catch (err) {
    console.error("checkNewMessages error:", err);
    return res.status(500).json({ hasNew: false });
  }
});

app.post("/markMessagesRead", async (req, res) => {
  try {
    const { playerId } = req.body;
    if (!playerId) return res.status(400).json({ error: "playerId required" });
    await Thread.findOneAndUpdate({ playerId }, { $set: { hasNew: false } }).exec();
    return res.json({ success: true });
  } catch (err) {
    console.error("markMessagesRead error:", err);
    return res.status(500).json({ error: "fail" });
  }
});

// ---------- Start server & DB & Discord ----------
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Connect MongoDB
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("✅ Connected to MongoDB");

    // start HTTP server
    app.listen(PORT, () => console.log(`🚀 HTTP server listening on ${PORT}`));

    // small delay, then login Discord
    setTimeout(() => {
      if (!process.env.DISCORD_TOKEN) {
        console.error("DISCORD_TOKEN missing");
        process.exit(1);
      }
      client.login(process.env.DISCORD_TOKEN).catch(err => {
        console.error("Discord login error:", err);
      });
    }, 3000);
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down...");
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  await mongoose.disconnect();
  client.destroy();
  process.exit(0);
});
