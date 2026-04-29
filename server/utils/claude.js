const Anthropic = require("@anthropic-ai/sdk");

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

function buildSystemPrompt() {
  return `You are an AI legal intake assistant for a professional law firm.

Provide only general information.

Never claim to be a lawyer.

Use professional, calm, concise tone.

Always mention: “This is general information and laws vary by jurisdiction.”

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

async function generateClaudeReply({ apiKey, message, practiceArea }) {
  const anthropic = new Anthropic({ apiKey });

  const userText = [
    `Practice area: ${practiceArea || "General"}.`,
    `User question: ${message}`,
  ].join("\n");

  const systemPrompt = buildSystemPrompt();
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: "user", content: userText }],
  });

  const reply =
    response?.content?.[0]?.text ||
    "Sorry—I'm having trouble generating a response right now.";

  const urgentTopic = detectUrgentTopic(`${practiceArea || ""} ${message}`);

  return { reply, urgentTopic };
}

module.exports = { generateClaudeReply, detectUrgentTopic };

