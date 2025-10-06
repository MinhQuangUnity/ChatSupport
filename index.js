import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();
app.use(express.json());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const MESSAGES_FILE = "./messages.json";

if (!fs.existsSync(MESSAGES_FILE)) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify({}), "utf-8");
}

function loadData() {
  return JSON.parse(fs.readFileSync(MESSAGES_FILE, "utf-8"));
}

function saveData(data) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
}

// Lưu tin nhắn và đánh dấu có tin mới
function saveMessage(playerId, from, text) {
  const data = loadData();
  if (!data[playerId]) data[playerId] = { messages: [], hasNew: false };

  data[playerId].messages.push({ from, text, time: new Date().toISOString() });
  if (from === "admin") data[playerId].hasNew = true; // Đánh dấu có tin mới
  saveData(data);
}

client.once("clientReady", () => console.log(`🤖 Bot ${client.user.tag} đã sẵn sàng!`));

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Trường hợp admin reply
  if (message.reference) {
    const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
    const match = repliedMsg.content.match(/\*\*(.*?)\*\*/);
    if (match) {
      const playerId = match[1];
      const text = message.content.trim();
      saveMessage(playerId, "admin", text);
      console.log(`💬 Admin → ${playerId}: ${text}`);
      return;
    }
  }

  // Trường hợp admin gửi theo format ID: message
  if (message.channel.id === process.env.CHANNEL_ID) {
    const [playerId, ...msgParts] = message.content.split(":");
    const text = msgParts.join(":").trim();
    if (!playerId || !text) return;
    saveMessage(playerId, "admin", text);
    console.log(`💬 Admin → ${playerId}: ${text}`);
  }
});

app.post("/sendMessage", async (req, res) => {
  const { playerId, text } = req.body;
  if (!playerId || !text) return res.status(400).json({ error: "Thiếu playerId hoặc text" });

  const data = loadData();
  if (!data[playerId]) data[playerId] = { messages: [], hasNew: false };

  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    await channel.send(`**${playerId}**: ${text}`);
    data[playerId].messages.push({ from: "player", text, time: new Date().toISOString() });
    saveData(data);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Lỗi gửi Discord:", error);
    res.status(500).json({ error: "Không gửi được tin nhắn" });
  }
});

// ✅ Lấy toàn bộ tin nhắn
app.get("/getMessages/:playerId", (req, res) => {
  const { playerId } = req.params;
  const data = loadData();
  res.json(data[playerId]?.messages || []);
});

// ✅ Kiểm tra có tin mới không
app.get("/checkNewMessages/:playerId", (req, res) => {
  const { playerId } = req.params;
  const data = loadData();
  res.json({ hasNew: data[playerId]?.hasNew || false });
});

// ✅ Đánh dấu đã đọc
app.post("/markMessagesRead", (req, res) => {
  const { playerId } = req.body;
  const data = loadData();
  if (data[playerId]) data[playerId].hasNew = false;
  saveData(data);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));

client.login(process.env.DISCORD_TOKEN);

