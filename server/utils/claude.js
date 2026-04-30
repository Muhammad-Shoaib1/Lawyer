const Anthropic = require("@anthropic-ai/sdk");

const DEFAULT_MODEL_CANDIDATES = [
  process.env.ANTHROPIC_MODEL,
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
].filter(Boolean);
let cachedWorkingModel = null;

function buildSystemPrompt() {
  return `You are an AI legal intake assistant for a professional law firm.

Provide only general information.

Never claim to be a lawyer.

Use professional, calm, concise tone.

Keep answers brief by default (about 90-140 words) unless the user explicitly asks for detail.

Always mention: “This is general information and laws vary by jurisdiction.”

When possible, cite 1-3 concrete legal references relevant to the user's jurisdiction (for example constitution articles, statute names/sections, or procedural rules). If uncertain, explicitly say the reference should be verified with local official sources.

IMPORTANT: The user may refer to "attached files" or "documents". These files have been extracted and their text contents are provided to you in the "Case files context" section below. Do NOT say you cannot see or read attachments; instead, read the provided text excerpts and address the user's questions based on them.

Recommend consultation when urgent.

Urgent topics:
* arrest
* deadlines
* immigration risk
* child custody emergency
* domestic violence
* eviction

When an urgent topic is detected, encourage booking a lawyer consultation and avoid any advice that could be construed as legal representation.`;
}

function detectUrgentTopic(text = "") {
  const t = text.toLowerCase();
  const urgentKeywords = [
    "arrest",
    "deadline",
    "deadlines",
    "immigration",
    "deport",
    "custody",
    "domestic violence",
    "eviction",
    "restraining order",
    "order of protection",
    "emergency custody",
    "incarcer",
  ];
  return urgentKeywords.some((k) => t.includes(k));
}

async function generateClaudeReply({
  apiKey,
  message,
  practiceArea,
  country,
  state,
  caseContext,
  skippedFiles = [],
}) {
  const anthropic = new Anthropic({ apiKey });

  const sections = [
    `Practice area: ${practiceArea || "General"}.`,
    `Jurisdiction country: ${country || "United States"}.`,
    `Jurisdiction state/region: ${state || "General"}.`,
    `User question: ${message}`,
  ];
  if (caseContext) {
    sections.push(`Case files context (user-uploaded excerpts):\n${caseContext}`);
  }
  if (skippedFiles.length > 0) {
    sections.push(`System Note: The user tried to upload the following files, but they could not be read because they are in an unsupported format: ${skippedFiles.join(", ")}. Please inform the user that you can only read text-based files (like .txt, .csv, .md) and ask them to copy-paste the text or upload a supported format.`);
  }
  const userText = sections.join("\n\n");

  const systemPrompt = buildSystemPrompt();
  let response = null;
  let lastErr = null;

  const modelsToTry = cachedWorkingModel
    ? [cachedWorkingModel, ...DEFAULT_MODEL_CANDIDATES.filter((m) => m !== cachedWorkingModel)]
    : DEFAULT_MODEL_CANDIDATES;

  for (const model of modelsToTry) {
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: 320,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }],
      });
      cachedWorkingModel = model;
      break;
    } catch (err) {
      lastErr = err;
      const type = String(err?.type || err?.error?.type || "").toLowerCase();
      const msg = String(err?.message || "").toLowerCase();
      const notFoundModel = type.includes("not_found") || msg.includes("model:");
      if (!notFoundModel) {
        // Non-model errors (billing/auth/network) should bubble immediately.
        throw err;
      }
    }
  }

  if (!response) {
    throw lastErr || new Error("No available Claude model could be used.");
  }

  const reply =
    response?.content?.[0]?.text ||
    "Sorry—I'm having trouble generating a response right now.";

  const urgentTopic = detectUrgentTopic(`${practiceArea || ""} ${message}`);

  return { reply, urgentTopic, mode: "live", modelUsed: cachedWorkingModel };
}

module.exports = { generateClaudeReply, detectUrgentTopic };

