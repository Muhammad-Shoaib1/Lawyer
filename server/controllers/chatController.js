const ChatHistory = require("../models/ChatHistory");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const { generateClaudeReply, detectUrgentTopic } = require("../utils/claude");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const MAX_CASE_CONTEXT_CHARS = 7000;
const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".pdf",
  ".docx",
]);

function normalizeString(v) {
  return typeof v === "string" ? v.trim() : "";
}

function getExt(filename = "") {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function parseBody(req) {
  const raw = req.body || {};
  const message = normalizeString(raw.message || raw.text || raw.q);
  return { message, practiceArea: "General", country: "United States", state: "General" };
}

async function buildCaseContext(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    return { context: "", acceptedFiles: [], skippedFiles: [] };
  }

  const acceptedFiles = [];
  const skippedFiles = [];
  const snippets = [];

  for (const file of files) {
    const ext = getExt(file?.originalname || "");
    const baseName = file?.originalname || "uploaded-file";
    if (!ALLOWED_TEXT_EXTENSIONS.has(ext)) {
      skippedFiles.push(`${baseName} (unsupported type)`);
      continue;
    }

    let asText = "";
    try {
      if (ext === ".pdf") {
        const data = await pdfParse(file.buffer);
        asText = (data.text || "").trim();
      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        asText = (result.value || "").trim();
      } else {
        // Default to plain text
        asText = String(file?.buffer?.toString("utf8") || "").trim();
      }
    } catch (err) {
      console.warn(`[chat] failed parsing ${baseName}:`, err?.message);
      skippedFiles.push(`${baseName} (parsing failed)`);
      continue;
    }

    if (!asText) {
      skippedFiles.push(`${baseName} (empty or unreadable)`);
      continue;
    }

    acceptedFiles.push(baseName);
    snippets.push(`File: ${baseName}\n${asText.slice(0, 2500)}`);
  }

  const context = snippets.join("\n\n---\n\n").slice(0, MAX_CASE_CONTEXT_CHARS);
  return { context, acceptedFiles, skippedFiles };
}

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
  const { message, practiceArea, country, state } = parseBody(req);

  if (typeof message !== "string" || !message.trim()) {
    return res.json({
      reply: "Please provide a legal question or message so I can assist you.",
      mode: "live",
      fileContext: { acceptedFiles: [], skippedFiles: [] },
      modeReason: ""
    });
  }

  const userMessage = message.trim();
  const area = practiceArea;
  const uploadedFiles = req.files || [];
  
  console.log("[chat] req.files length:", uploadedFiles.length);
  const caseData = await buildCaseContext(uploadedFiles);
  console.log("[chat] caseData:", caseData);

  const startTs = Date.now();
  let reply = "";
  let urgentTopic = false;
  let mode = "fallback";
  let modeReason = "";

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // Keeps the demo runnable without secrets; real deployment uses Claude.
      reply = buildFallbackReply({ practiceArea: area, message: userMessage });
      urgentTopic = detectUrgentTopic(`${area || ""} ${userMessage}`);
      mode = "fallback";
      modeReason = "ANTHROPIC_API_KEY is missing on server.";
    } else {
      const result = await generateClaudeReply({
        apiKey,
        message: userMessage,
        practiceArea: area,
        country,
        state,
        caseContext: caseData.context,
        skippedFiles: caseData.skippedFiles,
      });
      reply = result.reply;
      urgentTopic = result.urgentTopic;
      mode = result.mode || "live";
      modeReason = "";
    }

    const latencyMs = Date.now() - startTs;

    // MongoDB is optional; avoid long buffering delays when disconnected.
    if (require("mongoose").connection.readyState === 1) {
      try {
        await ChatHistory.create({
          practiceArea: area,
          userMessage,
          assistantReply: reply,
          urgentTopic,
          meta: {
            userAgent: getUserAgent(req),
            uploadedFiles: caseData.acceptedFiles,
            skippedFiles: caseData.skippedFiles,
            mode,
            country,
            state,
          },
        });

        await AnalyticsEvent.create({
          practiceArea: area,
          route: "/api/chat",
          eventType: "chat_generate",
          success: true,
          sessionId: null,
          meta: { latencyMs, country, state },
        });
      } catch (dbErr) {
        console.warn("[mongo] failed saving chat/analytics:", dbErr?.message);
      }
    }

    return res.json({
      reply,
      mode,
      fileContext: {
        acceptedFiles: caseData.acceptedFiles,
        skippedFiles: caseData.skippedFiles,
      },
      modeReason,
    });
  } catch (err) {
    const latencyMs = Date.now() - startTs;
    console.error("[chat] failed:", err);

    const anthropicFailureReply = buildAnthropicFailureReply(err);
    // Demo fallback: still return a safe general-information reply if it's not an auth/billing issue.
    const fallback =
      anthropicFailureReply ||
      buildFallbackReply({ practiceArea: area, message: userMessage });

    if (require("mongoose").connection.readyState === 1) {
      try {
        await AnalyticsEvent.create({
          practiceArea: area,
          route: "/api/chat",
          eventType: "chat_generate",
          success: false,
          error: err?.message || "unknown error",
          sessionId: null,
          meta: { latencyMs, country, state },
        });
      } catch (dbErr) {
        // ignore db failure
      }
    }

    return res.json({
      reply: fallback,
      mode: "fallback",
      modeReason: err?.message || "Claude request failed.",
      fileContext: {
        acceptedFiles: caseData.acceptedFiles,
        skippedFiles: caseData.skippedFiles,
      },
    });
  }
}

module.exports = { chatController };

