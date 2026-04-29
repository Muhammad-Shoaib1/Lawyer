const mongoose = require("mongoose");

async function connectToMongo() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.warn("[mongo] MONGO_URI not set; running without database.");
    return;
  }

  try {
    // Keep the demo resilient: if Mongo is unavailable, we still want the API to run.
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 3000,
      dbName: undefined,
    });
    console.log("[mongo] connected");
  } catch (err) {
    console.warn("[mongo] connection failed; continuing without database:", err?.code || err?.message || err);
  }
}

module.exports = { connectToMongo };

