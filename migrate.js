// migrate.js
import fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import ThreadModelFile from "./botModelsForMigrate.js"; // or just reuse schema in this file

// Simpler: define model inline (copy ThreadSchema)
const ThreadSchema = new mongoose.Schema({
  playerId: String,
  messages: Array,
  hasNew: Boolean
});
const Thread = mongoose.model("ThreadMigrate", ThreadSchema);

async function run() {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI missing");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const data = JSON.parse(fs.readFileSync("./messages.json", "utf8"));
  for (const playerId of Object.keys(data)) {
    const messages = data[playerId].messages || data[playerId] || data[playerId];
    // adapt if structure differs
    await Thread.findOneAndUpdate({ playerId }, { playerId, messages, hasNew: false }, { upsert: true });
    console.log("Migrated", playerId);
  }
  await mongoose.disconnect();
  console.log("Done");
  process.exit(0);
}

run().catch(e=>{console.error(e); process.exit(1);});
