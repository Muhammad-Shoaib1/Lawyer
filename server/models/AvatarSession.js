const mongoose = require("mongoose");

const AvatarSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, unique: true, index: true },
    sessionToken: { type: String },
    practiceArea: { type: String },
    status: { type: String, default: "active", index: true },
    lastActivityAt: { type: Date },
    endedAt: { type: Date },
    meta: {
      userAgent: { type: String },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model("AvatarSession", AvatarSessionSchema);

