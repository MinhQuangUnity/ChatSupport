// bot.js
import express from "express";
import cors from "cors";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField
} from "discord.js";
import dotenv from "dotenv";
import mongoose from "mongoose";
import cron from "node-cron";

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

// ---------- Ticket helpers ----------
const SUPPORT_CATEGORY_ID = process.env.SUPPORT_CATEGORY_ID; // 📂 Category “Hỗ Trợ”
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID; // 👮 Role admin có quyền xem

async function getOrCreateTicketChannel(guild, playerId) {
  const channelName = `ticket-${playerId.toLowerCase()}`;
  let channel = guild.channels.cache.find(ch => ch.name === channelName);

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: SUPPORT_CATEGORY_ID,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: ADMIN_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
    });

    await channel.send(`🎟️ Ticket mới từ **${playerId}**`);
    console.log(`Tạo ticket mới cho ${playerId}`);
  }
  return channel;
}

// ---------- Discord events ----------
client.once("ready", () => {
  console.log(`🤖 Bot ${client.user.tag} ready`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Chỉ xử lý tin nhắn trong category hỗ trợ
    if (message.channel.parentId === SUPPORT_CATEGORY_ID) {
      const playerId = message.channel.name.replace("ticket-", "");
      const text = message.content.trim();
      if (!text) return;

      await pushMessage(playerId, "admin", text);
      console.log(`Admin -> ${playerId}: ${text}`);
      // TODO: Gửi phản hồi về game qua API nếu cần
    }
  } catch (e) {
    console.error("Error processing messageCreate:", e);
  }
});

// ---------- Express endpoints ----------
app.get("/", (req, res) => res.send("✅ Support Chat Bot is running"));

// 🟢 Game gửi tin nhắn đến server
app.post("/sendMessage", async (req, res) => {
  try {
    const { playerId, text } = req.body;
    if (!playerId || !text) return res.status(400).json({ error: "playerId and text required" });

    const guild = client.guilds.cache.first();
    const channel = await getOrCreateTicketChannel(guild, playerId);

    await channel.send(`💬 **${playerId}**: ${text}`);
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

// ---------- Cron: xóa tin nhắn cũ hơn 7 ngày ----------
cron.schedule("0 0 * * *", async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const threads = await Thread.find({ "messages.time": { $lt: sevenDaysAgo } });

    for (const thread of threads) {
      thread.messages = thread.messages.filter(m => m.time >= sevenDaysAgo);
      await thread.save();
    }

    console.log(`🧹 Cleaned old messages at ${new Date().toLocaleString()}`);
  } catch (err) {
    console.error("Error cleaning old messages:", err);
  }
});

// ---------- Start server & DB & Discord ----------
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("✅ Connected to MongoDB");

    app.listen(PORT, () => console.log(`🚀 HTTP server listening on ${PORT}`));

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

// ---------- Graceful shutdown ----------
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
