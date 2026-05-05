const ChatHistory = require("../models/ChatHistory");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const {
  generateClaudeReply,
  generateClaudeReplyStream,
  generateEndSessionReport,
  detectUrgentTopic,
} = require("../utils/claude");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const PDFDocument = require("pdfkit");

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
  const mood = raw.mood || "Supportive";
  const promptMode = normalizeString(raw.promptMode || "default");
  const witnessName = normalizeString(raw.witnessName || "");
  const witnessTitle = normalizeString(raw.witnessTitle || "");
  const interviewerRole = normalizeString(raw.interviewerRole || "");
  let history = [];
  try {
    if (Array.isArray(raw.history)) history = raw.history;
    else if (typeof raw.history === "string" && raw.history.trim()) history = JSON.parse(raw.history);
  } catch {
    history = [];
  }
  return {
    message,
    mood,
    promptMode,
    witnessName,
    witnessTitle,
    interviewerRole,
    history,
    practiceArea: "General",
    country: "United States",
    state: "General",
  };
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

function toLineText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
}

function markdownToPlainText(markdown = "") {
  return String(markdown || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function createPdfBufferFromText({ title, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(14).text(String(title || "End-of-session report"), {
      align: "left",
    });
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(11);

    const lines = toLineText(text);
    for (const line of lines) {
      if (!line) {
        doc.moveDown(0.5);
        continue;
      }
      doc.text(line, { align: "left" });
    }
    doc.end();
  });
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function chatController(req, res) {
  console.log("[chat] Request received.");
  const { message, mood, promptMode, witnessName, witnessTitle, interviewerRole, history, practiceArea, country, state } = parseBody(req);
  console.log("[chat] Parsed body:", { message, mood, promptMode, practiceArea, country, state });

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
    console.log("[chat] Using API key:", apiKey ? "PRESENT" : "MISSING");

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
        mood,
        promptMode,
        witnessName,
        witnessTitle,
        interviewerRole,
        conversationHistory: history,
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
    console.error("[chat] Controller error caught:", err);
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

async function chatStreamController(req, res) {
  const { message, mood, promptMode, witnessName, witnessTitle, interviewerRole, history } = parseBody(req);
  console.log("[chat-stream] Controller hit.", { mood, promptMode });
  if (!message) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    writeSse(res, { error: "Please provide a legal question or message so I can assist you." });
    writeSse(res, { done: true });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn("[chat-stream] No API key, sending fallback SSE.");
    const reply = buildFallbackReply({ practiceArea: "General", message });
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    writeSse(res, { text: reply, mode: "fallback" });
    writeSse(res, { done: true });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  const uploadedFiles = req.files || [];
  const caseData = await buildCaseContext(uploadedFiles);
  console.log("[chat-stream] Case context length:", caseData.context.length);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    console.log("[chat-stream] Initializing Claude stream...");
    const stream = generateClaudeReplyStream({
      apiKey,
      message,
      mood,
      promptMode,
      witnessName,
      witnessTitle,
      interviewerRole,
      conversationHistory: history,
      caseContext: caseData.context,
      skippedFiles: caseData.skippedFiles,
    });

    let chunkCount = 0;
            for await (const chunk of stream) {
      chunkCount++;
      writeSse(res, { text: chunk });
    }

    console.log(`[chat-stream] Stream finished. Total chunks sent: ${chunkCount}`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[chat-stream] Error during streaming:", err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

async function endSessionReportController(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = req.body || {};
  const topic = normalizeString(body.topic || "Cross-examination practice");
  const transcript = normalizeString(body.transcript);
  const sideCounsel = normalizeString(body.sideCounsel || "Not stated");
  const difficulty = normalizeString(body.difficulty || "Not stated");
  const witnessTitle = normalizeString(body.witnessTitle || "");

  if (!transcript) {
    return res.status(400).json({ error: "Transcript is required." });
  }
  if (!apiKey) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY is missing on server." });
  }

  try {
    const result = await generateEndSessionReport({
      apiKey,
      topic,
      transcript,
      sideCounsel,
      difficulty,
      witnessTitle,
    });
    const safeTopic = topic.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "session";
    const pdfText = markdownToPlainText(result.report);
    const pdfBuffer = await createPdfBufferFromText({
      title: `End-of-session report - ${topic}`,
      text: pdfText,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="end-of-session-report-${safeTopic}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("[end-session-report] failed:", err);
    return res.status(500).json({
      error: err?.message || "Failed to generate end-of-session report.",
    });
  }
}

module.exports = { chatController, chatStreamController, endSessionReportController };

