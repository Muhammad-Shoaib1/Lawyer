import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const practiceAreas = [
  "Family Law",
  "Criminal Law",
  "Civil Law",
  "Immigration",
  "Business Law",
  "Employment Law",
  "Personal Injury",
  "Real Estate Law",
  "Intellectual Property",
  "Tax Law",
];
const COUNTRY_STATES = {
  "United States": [
    "California",
    "Texas",
    "New York",
    "Florida",
    "Illinois",
    "Pennsylvania",
  ],
  Pakistan: ["Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan", "Islamabad"],
  India: ["Maharashtra", "Delhi", "Karnataka", "Tamil Nadu", "Uttar Pradesh"],
  Canada: ["Ontario", "Quebec", "British Columbia", "Alberta", "Manitoba"],
  "United Kingdom": ["England", "Scotland", "Wales", "Northern Ireland"],
};

function formatTime(d) {
  try {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatBox({
  country,
  stateRegion,
  onCountryChange,
  onStateRegionChange,
  practiceArea,
  onPracticeAreaChange,
  messages,
  onSubmitMessage,
  isThinking,
  onVoiceStatusChange,
  onBargeInDetected,
  status,
  chatError,
  onDownloadConversation,
}) {
  const [draft, setDraft] = useState("");
  const [caseFiles, setCaseFiles] = useState([]);
  const [isSpeechSupported, setIsSpeechSupported] = useState(true);
  const recognitionRef = useRef(null);
  const lastInterimRef = useRef("");

  const SpeechRecognition =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;

  useEffect(() => {
    setIsSpeechSupported(!!SpeechRecognition);
  }, [SpeechRecognition]);

  const startRecognition = () => {
    if (!SpeechRecognition) return;
    if (isThinking) return;

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      onVoiceStatusChange?.("listening");
    };

    recognition.onerror = (event) => {
      console.warn("[speech] error:", event);
      onVoiceStatusChange?.("ready");
    };

    recognition.onend = () => {
      onVoiceStatusChange?.("ready");
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || "";
        if (result.isFinal) finalText += transcript;
        else interim += transcript;
      }

      const cleanedInterim = interim.trim();
      if (cleanedInterim && cleanedInterim !== lastInterimRef.current) {
        lastInterimRef.current = cleanedInterim;
      }

      if (finalText.trim()) {
        const cleaned = finalText.trim().replace(/\s+/g, " ");
        setDraft(cleaned);
        onBargeInDetected?.(cleaned);
        onVoiceStatusChange?.("ready");
        onSubmitMessage?.(cleaned);
      } else if (interim.trim()) {
        if (status === "speaking") onBargeInDetected?.(interim.trim());
        setDraft((prev) => {
          // Avoid fighting the user while they type.
          if (prev && prev !== lastInterimRef.current) return prev;
          return interim.trim();
        });
      }
    };

    try {
      recognition.start();
    } catch (e) {
      // start() can throw if called twice quickly
      console.warn("[speech] start failed:", e);
      onVoiceStatusChange?.("ready");
    }
  };

  const canSend = useMemo(() => {
    return !isThinking && draft.trim().length > 0;
  }, [draft, isThinking]);

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    onSubmitMessage?.({ text: t, files: caseFiles });
    setCaseFiles([]);
  };

  return (
    <div>
      <div className="sectionTitle">
        <div className="hint">Jurisdiction</div>
      </div>

      <div className="smallRow" style={{ marginTop: 0 }}>
        <select
          className="select"
          value={country}
          disabled={isThinking}
          onChange={(e) => {
            const nextCountry = e.target.value;
            onCountryChange?.(nextCountry);
            const firstState = COUNTRY_STATES[nextCountry]?.[0] || "General";
            onStateRegionChange?.(firstState);
          }}
          aria-label="Country"
        >
          {Object.keys(COUNTRY_STATES).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={stateRegion}
          disabled={isThinking}
          onChange={(e) => onStateRegionChange?.(e.target.value)}
          aria-label="State or region"
        >
          {(COUNTRY_STATES[country] || ["General"]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="sectionTitle">
        <div className="hint">Practice Area</div>
      </div>

      <div className="smallRow" style={{ marginTop: 0 }}>
        <select
          className="select"
          value={practiceArea}
          disabled={isThinking}
          onChange={(e) => onPracticeAreaChange?.(e.target.value)}
          aria-label="Practice Area"
        >
          {practiceAreas.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="formRow">
        <textarea
          className="input"
          rows={3}
          value={draft}
          disabled={isThinking}
          placeholder="Ask your legal question (general guidance only)..."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (canSend) submit();
            }
          }}
        />
        <button
          className="btn btnGold"
          type="button"
          disabled={!canSend}
          onClick={submit}
          aria-label="Send question"
        >
          Send
        </button>
      </div>
      <div className="smallRow" style={{ marginTop: 8 }}>
        <input
          type="file"
          multiple
          disabled={isThinking}
          onChange={(e) => {
            const next = Array.from(e.target.files || []);
            setCaseFiles(next.slice(0, 5));
          }}
          aria-label="Upload case files"
        />
        <div className="statusText">
          Upload up to 5 text files (.txt, .md, .csv, .json, .xml, .html, .log)
        </div>
      </div>
      {caseFiles.length > 0 ? (
        <div className="statusText" style={{ marginTop: 6 }}>
          Attached: {caseFiles.map((f) => f.name).join(", ")}
        </div>
      ) : null}

      <div className="smallRow">
        <button
          className="btn"
          type="button"
          disabled={!isSpeechSupported || isThinking}
          onClick={startRecognition}
        >
          Voice Input
        </button>
        <div className="statusText">
          {isSpeechSupported ? "Tip: press Ctrl/⌘ + Enter to send" : "Voice input not supported in this browser."}
        </div>
      </div>

      <div className="transcript glass" aria-label="Chat transcript">
        {messages.length === 0 ? (
          <div className="hint">
            Ask a question using text or voice. Claude generates the reply, and the avatar speaks it with the same text.
          </div>
        ) : null}

        {messages.map((m, idx) => (
          <div
            key={`${m.role}-${idx}`}
            className={`bubble ${m.role === "user" ? "bubbleUser" : "bubbleAI"}`}
          >
            <div className="metaLine">
              {m.role === "user" ? "You" : "Assistant"} • {formatTime(m.at)}
            </div>
            {m.role === "assistant" ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
            ) : (
              m.text
            )}
          </div>
        ))}
      </div>

      {chatError ? (
        <div className="retryRow">
          <div className="statusText" style={{ color: "rgba(255,255,255,0.85)" }}>
            {chatError.message}
          </div>
          {chatError.canRetry ? (
            <button
              className="btn btnGold"
              type="button"
              onClick={chatError.onRetry}
              disabled={isThinking}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="smallRow" style={{ marginTop: 10 }}>
        <button
          className="btn"
          type="button"
          onClick={onDownloadConversation}
          disabled={!messages.length}
        >
          Download Conversation
        </button>
      </div>
    </div>
  );
}

