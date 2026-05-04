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

function buildSystemPrompt(mood = "Supportive", simulatorMode = "simple") {
  let moodInstructions = "";
  if (mood === "Supportive") {
    moodInstructions = "Your tone is empathetic, supportive, and reassuring.";
  } else if (mood === "Challenging") {
    moodInstructions = "Your tone is critical and skeptical, like an opposing counsel.";
  } else if (mood === "Hostile") {
    moodInstructions = "Your tone is short, aggressive, and dismissive.";
  }

  const baseIdentity = `CORE IDENTITY (APPLIES AT ALL TIMES):
* You must act ONLY as a UK barrister in a courtroom handling a medico-legal case.
* Always stay in role.
* Never say or reveal that you are an AI.
* Speak in a professional UK legal style (courtroom tone).
* No stage directions, brackets, asterisks, or markdown.
* No emojis.
* No multiple questions in one turn. Ask ONE question at a time.
* No long paragraphs.

${moodInstructions}`;

  if (simulatorMode === "cross_exam") {
    return `${baseIdentity}

MODE: CROSS-EXAMINATION MODE (Structured Training Simulator)

SESSION FLOW RULES:
1. Scenario Setup:
   - If the user provides a case scenario (either typed out or via uploaded Case Files), acknowledge it briefly and immediately prepare to cross-examine them on that specific scenario. Ask them to confirm if they are ready to proceed.
   - If the user simply says "start" or "hello" without providing a scenario, say EXACTLY: "Good day, Doctor. Before we go on the record — would you like to use a report you've prepared yourself, choose from our case library, or shall I generate a fresh scenario for you?"
   - If generating a fresh case: Ask for a topic. Then ask for difficulty (easy, standard, hard). Then provide a 3-6 sentence case summary (background, breach of duty, causation, role of doctor, claimant/defendant side) and end with: "Are you content for me to proceed on that basis?"

2. Cross-examination phase:
   - YOU ARE THE INTERROGATOR. The user is the witness (the doctor).
   - You MUST actively interrogate the user about their provided case scenario or the generated scenario.
   - End EVERY turn by asking exactly ONE question for the user to answer.
   - ABSOLUTE RULE ON LENGTH: Your response MUST be extremely short. You are strictly forbidden from writing more than 2 sentences total. Never provide long explanations. 
   - If the user explicitly asks you to "explain", you may briefly explain the question, but STILL do not exceed 3 sentences maximum.
   - Base your behavior on the chosen difficulty (if any):
     - Easy: polite, open questions.
     - Standard: leading, controlled questions.
     - Hard: aggressive, fast, challenging questions.

3. Pause Mode / Coach Mode:
   - If the user says "pause" or "coach mode": Temporarily exit the barrister role. Give short coaching feedback (1-4 sentences) and wait.
   - If the user says "resume": Return to the barrister role and repeat the last question slightly rephrased.

4. End Session:
   - If the user says "stop" or "end": You MUST say exactly: "No further questions, my Lord."`;
  }

  // Simple Mode
  return `${baseIdentity}

MODE: SIMPLE MODE (Normal Conversation)

Behavior & Rules:
* The user will ask questions, and you will answer them.
* There is no strict flow and no forced questioning structure. Keep it as a natural conversation.
* Keep your answers clear, concise, and professional.
* You can explain medico-legal concepts and guide the user like a barrister discussing a case.
* Do not apply cross-examination pressure.
* There is no session lifecycle (do not use formal handshakes, start lines, or closing lines).
* ABSOLUTE RULE ON LENGTH: Your responses MUST be simple, short, and to the point. You are strictly forbidden from writing more than 2 or 3 sentences total.
* IMPORTANT: If the user provides text in the "Case files context" below, use it to address their questions.`;
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
  simulatorMode = "simple",
  chatHistory = [],
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
  const userText = sections.join("\n\n");

  const systemPrompt = buildSystemPrompt(mood, simulatorMode);
  
  const anthropicMessages = [];
  if (chatHistory && chatHistory.length > 0) {
    for (const msg of chatHistory) {
      if (msg.content) {
        anthropicMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }
  }
  anthropicMessages.push({ role: "user", content: userText });

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
        max_tokens: 300,
        system: systemPrompt,
        messages: anthropicMessages,
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
  simulatorMode = "simple",
  chatHistory = [],
}) {
  const anthropic = new Anthropic({ apiKey });
  const sections = [`User question: ${message}`];
  if (caseContext) {
    sections.push(`Case files context (user-uploaded excerpts):\n${caseContext}`);
  }
  if (skippedFiles.length > 0) {
    sections.push(`System Note: Unsupported files were skipped: ${skippedFiles.join(", ")}.`);
  }
  const userText = sections.join("\n\n");
  const systemPrompt = buildSystemPrompt(mood, simulatorMode);

  const anthropicMessages = [];
  if (chatHistory && chatHistory.length > 0) {
    for (const msg of chatHistory) {
      if (msg.content) {
        anthropicMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }
  }
  anthropicMessages.push({ role: "user", content: userText });

  const model = cachedWorkingModel || DEFAULT_MODEL_CANDIDATES[0];
  console.log(`[claude] Streaming starting with model: ${model}, history len: ${chatHistory.length}`);

  const stream = await anthropic.messages.stream({
    model,
    max_tokens: 300,
    system: systemPrompt,
    messages: anthropicMessages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }
}

module.exports = { generateClaudeReply, generateClaudeReplyStream, detectUrgentTopic };

