const mongoose = require("mongoose");

const AnalyticsEventSchema = new mongoose.Schema(
  {
    practiceArea: { type: String, index: true },
    route: { type: String, index: true },
    eventType: { type: String, index: true },
    success: { type: Boolean, index: true },
    error: { type: String },
    sessionId: { type: String, index: true },
    createdAt: { type: Date, default: Date.now },
    meta: {
      latencyMs: { type: Number },
    },
  },
  { _id: false }
);

module.exports = mongoose.model("AnalyticsEvent", AnalyticsEventSchema, "analytics_events");

