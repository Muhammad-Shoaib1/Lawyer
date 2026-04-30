const ChatHistory = require("../models/ChatHistory");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const { generateClaudeReply, detectUrgentTopic } = require("../utils/claude");

function getUserAgent(req) {
  return (
    req.headers["user-agent"] ||
    req.headers["User-Agent"] ||
    "unknown-user-agent"
  );
}

function buildFallbackReply({ practiceArea, message }) {
  const urgent = detectUrgentTopic(`${practiceArea || ""} ${message}`);
  const base =
    "This is general information and laws vary by jurisdiction. " +
    "For case-specific advice, consider booking a consultation with a qualified attorney. ";

  if (!urgent) {
    return (
      base +
      "If you share more details (dates, location, and what has happened so far), you can ask for general next steps and document checklists."
    );
  }

  // Urgent topics: recommend prompt legal help.
  return (
    base +
    "Your situation may involve urgent legal risk. If you are facing arrest, deadlines, immigration risk, an urgent child custody situation, domestic violence, or eviction, seek prompt legal help immediately."
  );
}

function buildAnthropicFailureReply(err) {
  const text = String(err?.message || err || "").toLowerCase();
  if (text.includes("credit balance is too low") || text.includes("insufficient")) {
    return (
      "Claude is currently unavailable for this demo because the configured Anthropic API key has insufficient credits. " +
      "Please add credits (or use a funded API key) and try again."
    );
  }
  if (text.includes("api key") || text.includes("unauthorized") || text.includes("forbidden")) {
    return (
      "Claude is currently unavailable because the Anthropic API key appears invalid or unauthorized. " +
      "Please update the API key and try again."
    );
  }
  return null;
}

async function chatController(req, res) {
  const { message, practiceArea } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const userMessage = message.trim();
  const area = typeof practiceArea === "string" ? practiceArea : "General";

  const startTs = Date.now();
  let reply = "";
  let urgentTopic = false;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // Keeps the demo runnable without secrets; real deployment uses Claude.
      reply = buildFallbackReply({ practiceArea: area, message: userMessage });
      urgentTopic = detectUrgentTopic(`${area || ""} ${userMessage}`);
    } else {
      const result = await generateClaudeReply({
        apiKey,
        message: userMessage,
        practiceArea: area,
      });
      reply = result.reply;
      urgentTopic = result.urgentTopic;
    }

    const latencyMs = Date.now() - startTs;

    // Save chat history + analytics (MongoDB is optional for local demo).
    try {
      await ChatHistory.create({
        practiceArea: area,
        userMessage,
        assistantReply: reply,
        urgentTopic,
        meta: { userAgent: getUserAgent(req) },
      });

      await AnalyticsEvent.create({
        practiceArea: area,
        route: "/api/chat",
        eventType: "chat_generate",
        success: true,
        sessionId: null,
        meta: { latencyMs },
      });
    } catch (dbErr) {
      console.warn("[mongo] failed saving chat/analytics:", dbErr?.message);
    }

    return res.json({ reply });
  } catch (err) {
    const latencyMs = Date.now() - startTs;
    console.error("[chat] failed:", err);

    const anthropicFailureReply = buildAnthropicFailureReply(err);
    // Demo fallback: still return a safe general-information reply if it's not an auth/billing issue.
    const fallback =
      anthropicFailureReply ||
      buildFallbackReply({ practiceArea: area, message: userMessage });

    try {
      await AnalyticsEvent.create({
        practiceArea: area,
        route: "/api/chat",
        eventType: "chat_generate",
        success: false,
        error: err?.message || "unknown error",
        sessionId: null,
        meta: { latencyMs },
      });
    } catch (dbErr) {
      // ignore db failure
    }

    return res.json({ reply: fallback });
  }
}

module.exports = { chatController };

