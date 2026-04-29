const mongoose = require("mongoose");

const ChatHistorySchema = new mongoose.Schema(
  {
    practiceArea: { type: String, index: true },
    userMessage: { type: String, required: true },
    assistantReply: { type: String, required: true },
    urgentTopic: { type: Boolean, default: false, index: true },
    meta: {
      userAgent: { type: String },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model("ChatHistory", ChatHistorySchema);

