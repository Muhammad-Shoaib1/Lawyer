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

const MAX_CASE_CONTEXT_CHARS = 30000;
const ALLOWED_TEXT_EXTENSIONS = new Set([".txt", ".pdf", ".docx", ".md", ".csv"]);

function normalizeString(v) { return typeof v === "string" ? v.trim() : ""; }
function getExt(filename = "") { const idx = filename.lastIndexOf("."); return idx >= 0 ? filename.slice(idx).toLowerCase() : ""; }

function parseBody(req) {
  const raw = req.body || {};
  const message = normalizeString(raw.message || raw.text || raw.q);
  const promptMode = normalizeString(raw.promptMode || "default");
  const witnessName = normalizeString(raw.witnessName || "");
  const witnessTitle = normalizeString(raw.witnessTitle || "");
  const interviewerRole = normalizeString(raw.interviewerRole || "");
  let history = [];
  try {
    if (Array.isArray(raw.history)) history = raw.history;
    else if (typeof raw.history === "string" && raw.history.trim()) history = JSON.parse(raw.history);
  } catch { history = []; }
  const moodList = ["Supportive", "Challenging", "Hostile"];
  let detectedMood = raw.mood || "Supportive";
  if (message && moodList.some(m => message.toLowerCase().includes(m.toLowerCase()))) {
    detectedMood = moodList.find(m => message.toLowerCase().includes(m.toLowerCase()));
  }
  return { message, mood: detectedMood, promptMode, witnessName, witnessTitle, interviewerRole, history, practiceArea: "General", country: "United States", state: "General" };
}

async function buildCaseContext(files = []) {
  if (!Array.isArray(files) || files.length === 0) return { context: "", acceptedFiles: [], skippedFiles: [] };
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
        console.log(`[chat] Parsing PDF: ${baseName}`);
        const data = await pdfParse(Buffer.from(file.buffer));
        asText = (data.text || "").trim();
        if (asText.length < 50) {
          console.warn(`[chat] PDF ${baseName} appears to be a scanned image.`);
          asText = ""; 
        }
      } else if (ext === ".docx") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        asText = (result.value || "").trim();
      } else {
        asText = String(file?.buffer?.toString("utf8") || "").trim();
      }
    } catch (err) {
      console.error(`[chat] FAILED parsing ${baseName}:`, err);
      skippedFiles.push(`${baseName} (parsing failed)`);
      continue;
    }

    if (!asText) {
      if (ext === ".pdf") {
        skippedFiles.push(`${baseName} (unreadable - likely a scanned image PDF)`);
      } else {
        skippedFiles.push(`${baseName} (empty or unreadable)`);
      }
      continue;
    }
    acceptedFiles.push(baseName);
    snippets.push(`File: ${baseName}\n${asText.slice(0, 10000)}`);
  }
  const context = snippets.join("\n\n---\n\n").slice(0, MAX_CASE_CONTEXT_CHARS);
  return { context, acceptedFiles, skippedFiles };
}

function getUserAgent(req) { return req.headers["user-agent"] || "unknown"; }
function writeSse(res, payload) { res.write(`data: ${JSON.stringify(payload)}\n\n`); }

function buildFallbackReply({ practiceArea, message }) {
  const urgent = detectUrgentTopic(`${practiceArea || ""} ${message}`);
  const base = "This is general information and laws vary by jurisdiction. For case-specific advice, consider booking a consultation with a qualified attorney. ";
  if (!urgent) return base + "If you share more details, you can ask for general next steps.";
  return base + "Your situation may involve urgent legal risk. Seek prompt legal help immediately.";
}

async function chatController(req, res) {
  const body = parseBody(req);
  const uploadedFiles = req.files || [];
  const caseData = await buildCaseContext(uploadedFiles);
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ reply: buildFallbackReply({ practiceArea: "General", message: body.message }), mode: "fallback", fileContext: { acceptedFiles: caseData.acceptedFiles, skippedFiles: caseData.skippedFiles } });
    }
    const result = await generateClaudeReply({ apiKey, ...body, caseContext: caseData.context, skippedFiles: caseData.skippedFiles });
    return res.json({ reply: result.reply, mode: result.mode || "live", fileContext: { acceptedFiles: caseData.acceptedFiles, skippedFiles: caseData.skippedFiles } });
  } catch (err) {
    console.error("[chat] Controller error:", err);
    return res.json({ reply: "An error occurred.", mode: "fallback", fileContext: { acceptedFiles: caseData.acceptedFiles, skippedFiles: caseData.skippedFiles } });
  }
}

async function chatStreamController(req, res) {
  const body = parseBody(req);
  const uploadedFiles = req.files || [];
  const caseData = await buildCaseContext(uploadedFiles);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      writeSse(res, { text: buildFallbackReply({ practiceArea: "General", message: body.message }), mode: "fallback" });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const stream = generateClaudeReplyStream({ apiKey, ...body, caseContext: caseData.context, skippedFiles: caseData.skippedFiles });
    for await (const chunk of stream) { writeSse(res, { text: chunk }); }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[chat-stream] Error:", err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

function markdownToPlainText(markdown = "") {
  return String(markdown || "").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "• ").replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

function toLineText(value) {
  return String(value || "").replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
}

function createPdfBufferFromText({ title, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    doc.font("Helvetica-Bold").fontSize(14).text(String(title || "Report"), { align: "left" });
    doc.moveDown(0.6);
    doc.font("Helvetica").fontSize(11);
    const lines = toLineText(text);
    for (const line of lines) {
      if (!line) { doc.moveDown(0.5); continue; }
      doc.text(line, { align: "left" });
    }
    doc.end();
  });
}

async function endSessionReportController(req, res) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const body = req.body || {};
    const transcript = body.transcript || "";
    
    // Generate the Claude summary/analysis
    const result = await generateEndSessionReport({ 
      apiKey, 
      ...body 
    });
    
    // Combine the summary and the full transcript
    const combinedText = `${markdownToPlainText(result.report)}\n\n` +
                        `==========================================\n` +
                        `           FULL TRANSCRIPT            \n` +
                        `==========================================\n\n` +
                        `${transcript}`;

    const pdfBuffer = await createPdfBufferFromText({ 
      title: `Legal Session Report - ${body.topic || "General"}`, 
      text: combinedText 
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="session-report.pdf"');
    res.status(200).send(pdfBuffer);
  } catch (err) { 
    console.error("[report] Error:", err);
    res.status(500).json({ error: err.message }); 
  }
}

module.exports = { chatController, chatStreamController, endSessionReportController };
