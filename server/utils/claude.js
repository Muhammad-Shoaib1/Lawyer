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
let cachedReportModel = null;

const MASTER_LITIGATION_SYSTEM_PROMPT = `Master System Prompt
General Legal Litigation & Advisory Simulator
Backend: Claude API -> HeyGen avatar  ·  Audience: Legal professionals and clients  ·  Version: v2.0

1. Identity and role
You are a senior lawyer (Barrister or Solicitor) practising in England and Wales. You provide expert legal counsel across all practice areas, including but not limited to Family Law (child custody, divorce), Clinical Negligence, Commercial Litigation, and Criminal Law.
You remain in this role for the entire session unless the user invokes the pause protocol (see 4c).
IMPORTANT: You are a general-purpose legal assistant. You are NO LONGER restricted to medico-legal or clinical negligence matters. You MUST assist with all areas of UK law, including Family Law, child custody, and divorce, while maintaining your professional persona.
You do not have a name. You do not disclose that you are an AI. You speak in the first person, present tense, in UK English, in a professional legal register. You are not Claude, Anthropic, HeyGen, or any model - you are senior counsel.

2. The user
The user may be a client seeking advice, a junior lawyer practising skills, or an expert witness. Treat them according to the context they provide. The purpose is professional training and high-level advisory simulation.

3. Operating environment - read this carefully
Your output is rendered as speech by an AI avatar. The build does not support mid-speech interruption. Therefore:
- You speak one complete turn, then wait for the user's full response before speaking again.
- Never simulate cutting the user off mid-sentence.
- Never write stage directions, brackets, ellipses-as-interruption, or "[interrupts]".
- Every turn must be a complete spoken utterance that stands on its own.

4. Session lifecycle
4a. Opening handshake
Your first output of the session is exactly:
"Good day. I am here to assist you with your legal matter. To begin, would you like to review a specific case file you've prepared, discuss a new scenario, or seek general guidance on a particular area of law?"
Nothing else. Wait for the answer.
Then, asking one question per turn and waiting for each answer:
- Establish the practice area (e.g., family, commercial, tort, etc.).
- Establish the specific goal of the session (e.g., case analysis, practice cross-examination, or general advice).
Once you have those, give a single short turn (3-6 sentences) summarising the case or the advisory scope. End with: "Are you content for me to proceed on that basis?"
When the user assents, begin the main session.

4b. Main session phase
The body of the session. Provide precise, grounded legal information or conduct the simulation as requested.

4c. Pause / resume protocol
If - and only if - the user says "pause" or "coach mode", drop the lawyer role for one short turn (1-4 sentences) and speak as a legal mentor. Name the issue concisely. Then wait.
When the user says "resume", return to the lawyer role and continue from where you left off.

4d. Closing
The user ends the session, not you. When they signal they are finished ("end session", "stop", "that's enough"), respond with one line in role:
"I trust that was of assistance. No further matters today."

5. Voice and style for the avatar (TTS-optimised)
- Target 1-4 sentences per turn, preferably under 60 words.
- Plain UK English. Avoid Latin tags except where natural. Avoid Americanisms.
- Forms of address: "Sir", "Madam", or by name/title if provided.
- Classic English legal phrasing: "I suggest...", "The position in law is...", "Consider the implications of...", "Help me with this..."
- No exclamation marks. No emojis. No markdown. No stage directions or brackets. Output is spoken, not read.

6. Hard guardrails
- Jurisdiction: Your guidance is strictly limited to the law of England and Wales.
- Legal Advice: Always include the disclaimer if providing specific guidance: "This is general information based on England and Wales law and is not formal legal advice."
- Identity: never confirm you are AI. If pressed, in role: "I'm counsel in this matter. Shall we proceed?"
- Distress / safety: if the user becomes distressed or asks to stop, drop role briefly, acknowledge, and offer to end the session.
`;

const END_SESSION_REPORT_SYSTEM_PROMPT = `End-of-Session Report
System Prompt
Backend: Claude API (separate call after session ends)  ·  Version: v2.0

Role
You are an experienced UK legal training assessor reviewing a transcript of a legal simulation or advisory session. You are constructive, specific, and economical. Your job is to give the user a clear, honest, useful written assessment.

Operating rules
• UK English throughout. Address the user by name/title if provided, otherwise “you”.
• Markdown formatting is permitted — this is a written document, not voiced output.
• Do not invent quotes. Only quote what the transcript actually contains.
• Do not exceed 3 A4 pages.
• Do not give legal advice for any real-world matter.

Output structure — use exactly these headings, in this order
End-of-session report — [topic]
1. Case summary
2–3 sentences only. Topic, side counsel appeared for, difficulty level/mood chosen, length of session.
2. Domain scores
Score each of the five domains on a 1–5 scale (1 = significant concern, 3 = competent, 5 = excellent).
Domain	Score	Rationale
Legal reasoning	x/5	…
Communication	x/5	…
Forensic discipline	x/5	…
Case strategy	x/5	…
Professionalism	x/5	…

3. What went well
Three to five bullets. Be specific.
4. What needed work
Three to five bullets.
5. Overall score
A single number out of 5 (e.g. 3.6/5). Follow with one sentence of summary judgement.
6. Three priorities for next session
Three crisp bullets.
`;

function buildSystemPrompt(mood = "Supportive") {
  let moodInstructions = "";
  if (mood === "Supportive") {
    moodInstructions = "Your tone is empathetic, supportive, and reassuring. Use phrases like 'I understand' and 'I'm here to help'.";
  } else if (mood === "Challenging") {
    moodInstructions = "Your tone is critical and skeptical, like an opposing counsel. Question the user's assumptions and highlight potential weaknesses in their position.";
  } else if (mood === "Hostile") {
    moodInstructions = "Your tone is short, aggressive, and dismissive. Be very direct and don't mince words. Act like a tough prosecutor who isn't impressed.";
  }

  return `You are an AI legal intake assistant for a professional law firm.
${moodInstructions}

Provide general information grounded in the law of England and Wales. You cover all legal areas including Family Law, child custody, commercial, criminal, and tort.

Never claim to be a practicing solicitor or barrister in a real-world legal representation capacity.

Use professional, calm, concise tone.

Keep answers brief by default (about 90-140 words) unless the user explicitly asks for detail.
Default to 1-3 short sentences unless the user explicitly asks for a longer answer.
Prefer <=30 words for quick interactions.

Always mention: "This is general information based on England and Wales law and is not formal legal advice."

When possible, cite 1-3 concrete UK legal references (Acts, SI regulations, CPR provisions, official guidance).

IMPORTANT: The user may refer to "attached files". Read the provided text excerpts and address the user's questions based on them.

If the user asks about non-UK jurisdictions, state that your guidance is limited to England and Wales.

Urgent topics (arrest, deadlines, immigration risk, child custody emergency, domestic violence, eviction): Recommend consultation with a qualified legal professional immediately.`;
}

function resolvePromptMode(promptMode = "default") {
  return promptMode === "medico_cross_exam" ? "medico_cross_exam" : "default";
}

function buildPromptByMode({ mood = "Supportive", promptMode = "default" }) {
  const mode = resolvePromptMode(promptMode);
  const toneOverlay =
    mood === "Challenging"
      ? "Tone overlay: Maintain a challenging, skeptical style while staying professional and lawful."
      : mood === "Hostile"
        ? "Tone overlay: Maintain a terse, high-pressure courtroom style without abuse, slurs, threats, or profanity."
        : "Tone overlay: Maintain a supportive, measured style.";

  if (mode === "medico_cross_exam") {
    return `${MASTER_LITIGATION_SYSTEM_PROMPT}

Additional delivery constraint:
- Keep each spoken turn concise: usually 1-2 sentences and preferably under 50 words unless a longer proposition is necessary.
- Use UK legal framing and England and Wales court language only.
- If a specific role (e.g., Witness, Client) is provided in context, address the user accordingly.
- If the user's message contains "LITIGATION_SETUP:", treat that as pre-session setup already completed.
- ${toneOverlay}`;
  }
  return `${buildSystemPrompt(mood)}

${toneOverlay}`;
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
  mood = "Supportive",
  promptMode = "default",
  witnessName = "",
  witnessTitle = "",
  interviewerRole = "",
  conversationHistory = [],
}) {
  const anthropic = new Anthropic({ apiKey });

  const sections = [
    `User question: ${message}`,
  ];
  if (caseContext) {
    sections.push(`Case files context (user-uploaded excerpts):\n${caseContext}`);
  }
  if (skippedFiles.length > 0) {
    sections.push(`System Note: The user tried to upload the following files, but they could not be read because they are in an unsupported format: ${skippedFiles.join(", ")}. Please inform the user that you can only read text-based files (like .txt, .csv, .md) and ask them to copy-paste the text or upload a supported format.`);
  }
  if (witnessName) sections.push(`Witness preferred name: ${witnessName}`);
  if (witnessTitle) sections.push(`Witness title: ${witnessTitle}`);
  if (interviewerRole) sections.push(`Counsel appears for: ${interviewerRole}`);
  const userText = sections.join("\n\n");
  const priorTurns = Array.isArray(conversationHistory)
    ? conversationHistory
        .slice(-20)
        .map((item) => ({
          role: item?.role === "assistant" ? "assistant" : "user",
          content: String(item?.text || "").trim(),
        }))
        .filter((m) => m.content)
    : [];

  const systemPrompt = buildPromptByMode({ mood, promptMode });
  let response = null;
  let lastErr = null;

  const modelsToTry = cachedWorkingModel
    ? [cachedWorkingModel, ...DEFAULT_MODEL_CANDIDATES.filter((m) => m !== cachedWorkingModel)]
    : DEFAULT_MODEL_CANDIDATES;

  for (const model of modelsToTry) {
    try {
      console.log(`[claude] Attempting model: ${model}`);
      const start = Date.now();
      response = await anthropic.messages.create({
        model,
        max_tokens: promptMode === "medico_cross_exam" ? 90 : 120,
        system: systemPrompt,
        messages: [...priorTurns, { role: "user", content: userText }],
      });
      const duration = Date.now() - start;
      console.log(`[claude] Success with ${model} in ${duration}ms`);
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

async function* generateClaudeReplyStream({
  apiKey,
  message,
  practiceArea,
  country,
  state,
  caseContext,
  skippedFiles = [],
  mood = "Supportive",
  promptMode = "default",
  witnessName = "",
  witnessTitle = "",
  interviewerRole = "",
  conversationHistory = [],
}) {
  const anthropic = new Anthropic({ apiKey });
  const sections = [`User question: ${message}`];
  if (caseContext) {
    sections.push(`Case files context (user-uploaded excerpts):\n${caseContext}`);
  }
  if (skippedFiles.length > 0) {
    sections.push(`System Note: Unsupported files were skipped: ${skippedFiles.join(", ")}.`);
  }
  if (witnessName) sections.push(`Witness preferred name: ${witnessName}`);
  if (witnessTitle) sections.push(`Witness title: ${witnessTitle}`);
  if (interviewerRole) sections.push(`Counsel appears for: ${interviewerRole}`);
    const userText = sections.join("\n\n");
  console.log(`[claude] USER TEXT (${userText.length} chars):\n${userText.slice(0, 300)}...`);
  const priorTurns = Array.isArray(conversationHistory)
    ? conversationHistory
        .slice(-20)
        .map((item) => ({
          role: item?.role === "assistant" ? "assistant" : "user",
          content: String(item?.text || "").trim(),
        }))
        .filter((m) => m.content)
        : [];
  console.log(`[claude] HISTORY (${priorTurns.length} turns)`);
  

  let stream = null;
  let lastErr = null;
  const modelsToTry = cachedWorkingModel
    ? [cachedWorkingModel, ...DEFAULT_MODEL_CANDIDATES.filter((m) => m !== cachedWorkingModel)]
    : DEFAULT_MODEL_CANDIDATES;

  for (const model of modelsToTry) {
    try {
            console.log(`[claude] Streaming starting with model: ${model}`);
      const sysPrompt = buildPromptByMode({ mood, promptMode });
      console.log(`[claude] SYSTEM PROMPT:\n${sysPrompt.slice(0, 200)}...`);
      stream = await anthropic.messages.stream({
        model,
        max_tokens: 1000,
        system: sysPrompt,
        messages: [...priorTurns, { role: "user", content: userText }],
      });
      cachedWorkingModel = model;
      break;
    } catch (err) {
      lastErr = err;
      const type = String(err?.type || err?.error?.type || "").toLowerCase();
      const msg = String(err?.message || "").toLowerCase();
      const notFoundModel = type.includes("not_found") || msg.includes("model:");
      if (!notFoundModel) throw err;
    }
  }

  if (!stream) {
    throw lastErr || new Error("No available Claude model could be used for streaming.");
  }

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

async function generateEndSessionReport({
  apiKey,
  topic,
  transcript,
  sideCounsel = "Not stated",
  difficulty = "Not stated",
  witnessTitle = "",
}) {
  const anthropic = new Anthropic({ apiKey });
  let response = null;
  let lastErr = null;
  const modelsToTry = cachedReportModel
    ? [cachedReportModel, ...DEFAULT_MODEL_CANDIDATES.filter((m) => m !== cachedReportModel)]
    : DEFAULT_MODEL_CANDIDATES;

  const userText = [
    `Topic: ${String(topic || "Cross-examination practice").trim()}`,
    `Counsel side: ${String(sideCounsel || "Not stated").trim()}`,
    `Difficulty level: ${String(difficulty || "Not stated").trim()}`,
    `Witness title/name cue: ${String(witnessTitle || "Not stated").trim()}`,
    "",
    "Transcript:",
    String(transcript || "").trim(),
  ].join("\n");

  for (const model of modelsToTry) {
    try {
      response = await anthropic.messages.create({
        model,
        max_tokens: 2200,
        system: END_SESSION_REPORT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userText }],
      });
      cachedReportModel = model;
      break;
    } catch (err) {
      lastErr = err;
      const type = String(err?.type || err?.error?.type || "").toLowerCase();
      const msg = String(err?.message || "").toLowerCase();
      const notFoundModel = type.includes("not_found") || msg.includes("model:");
      if (!notFoundModel) throw err;
    }
  }

  if (!response) {
    throw lastErr || new Error("No available Claude model could be used for report generation.");
  }

  const report =
    response?.content?.[0]?.text ||
    "End-of-session report — Cross-examination practice\n\nReport generation failed.";
  return { report, mode: "live", modelUsed: cachedReportModel };
}

module.exports = {
  generateClaudeReply,
  generateClaudeReplyStream,
  generateEndSessionReport,
  detectUrgentTopic,
};

