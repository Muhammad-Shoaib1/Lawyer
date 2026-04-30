import React, { useCallback, useMemo, useRef, useState } from "react";
import ChatBox from "./ChatBox.jsx";
import SuggestedQuestions from "./SuggestedQuestions.jsx";
import AvatarPanel from "./AvatarPanel.jsx";
import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk";

const SUGGESTED_QUESTION_BANK = {
  "Family Law": [
    "How does child custody usually get decided?",
    "What are the first steps to file for divorce?",
    "Can alimony be modified after divorce?",
    "How can I document issues for a custody case?",
    "What does legal separation mean in practice?",
    "How is child support usually calculated?",
  ],
  "Criminal Law": [
    "What should I do immediately after an arrest?",
    "How does bail work in most jurisdictions?",
    "What is the difference between a misdemeanor and felony?",
    "When should I avoid speaking to police?",
    "What happens at an arraignment hearing?",
    "Can charges be dropped before trial?",
  ],
  "Civil Law": [
    "What documents help in a civil dispute?",
    "How do I know if I should file a lawsuit?",
    "What is the usual timeline for a civil case?",
    "How are damages calculated in civil matters?",
    "What is the difference between settlement and trial?",
    "Can I represent myself in civil court?",
  ],
  Immigration: [
    "What can I do after a visa overstay notice?",
    "How do I prepare for an immigration interview?",
    "What evidence helps in an asylum case?",
    "When should I file for adjustment of status?",
    "What happens if I miss an immigration hearing?",
    "How do I track my immigration case status?",
  ],
  "Business Law": [
    "Should I form an LLC or a corporation?",
    "What clauses are critical in a service contract?",
    "How can I handle a contract breach?",
    "What legal basics should a startup cover first?",
    "How do I protect my business from liability?",
    "When should a business involve legal counsel?",
  ],
  "Employment Law": [
    "What should I do before reporting workplace harassment?",
    "How do wrongful termination claims usually work?",
    "What records should I keep for wage disputes?",
    "Can an employer change my contract terms suddenly?",
    "What are common signs of retaliation at work?",
    "How do I document unpaid overtime issues?",
  ],
  "Personal Injury": [
    "What evidence is most important after an accident?",
    "How long do I have to file an injury claim?",
    "Should I speak to the insurance adjuster directly?",
    "How is pain and suffering usually assessed?",
    "What medical records should I gather first?",
    "When should I consider settlement versus court?",
  ],
  "Real Estate Law": [
    "What should I review before signing a lease?",
    "How do property boundary disputes get handled?",
    "What are common legal risks in home purchases?",
    "Can I break a lease early without penalties?",
    "What should I do if a seller hides defects?",
    "How can I handle landlord maintenance violations?",
  ],
  "Intellectual Property": [
    "Should I trademark my brand name first?",
    "What is the difference between copyright and trademark?",
    "How do I respond to a cease-and-desist letter?",
    "When should I file a patent application?",
    "How do I protect app code from copying?",
    "What steps help enforce IP rights online?",
  ],
  "Tax Law": [
    "What should I do after getting an IRS notice?",
    "How can I dispute a tax assessment?",
    "What records should I keep for an audit?",
    "When is a payment plan usually possible?",
    "How do penalties and interest typically accrue?",
    "What are common options for tax debt relief?",
  ],
};

function pickRandomQuestions(area, refreshNonce, count = 4) {
  const pool = SUGGESTED_QUESTION_BANK[area] || SUGGESTED_QUESTION_BANK["Family Law"];
  const decorated = pool.map((q, idx) => ({
    q,
    // refreshNonce ensures a different shuffle across page refreshes.
    sortKey: Math.sin((refreshNonce + 1) * (idx + 1) * 99991),
  }));
  decorated.sort((a, b) => a.sortKey - b.sortKey);
  return decorated.slice(0, count).map((entry) => entry.q);
}

function formatNow() {
  return new Date();
}

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
}

function parseAvatarStartError(err) {
  const raw = String(err?.message || err || "");
  const lower = raw.toLowerCase();

  if (lower.includes("insufficient credits")) {
    return "LiveAvatar credits are insufficient for starting a live session. Please top up credits in your LiveAvatar account.";
  }
  if (lower.includes("forbidden") || lower.includes("403")) {
    return "LiveAvatar rejected session start (403). Check API key permissions, avatar access, and account limits.";
  }
  return "Live avatar session could not start right now. Using speech fallback.";
}

function isBenignAvatarCleanupError(reason) {
  const text = String(reason?.message || reason || "").toLowerCase();
  return text.includes("session not found") || text.includes("/v1/sessions/stop");
}

async function postJson(url, body, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(
        data?.error || data?.message || `Request failed with ${res.status}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

export default function MainSection() {
  const [practiceArea, setPracticeArea] = useState("Family Law");
  const [refreshNonce] = useState(() => Date.now() + Math.floor(Math.random() * 100000));
  const [status, setStatus] = useState("ready"); // ready | listening | thinking | speaking

  const [sessionId, setSessionId] = useState(null);
  const [muted, setMuted] = useState(false);

  const videoRef = useRef(null);
  const liveSessionRef = useRef(null);
  const speakTimeoutRef = useRef(null);
  const [liveEnabled, setLiveEnabled] = useState(false);

  const [isAvatarLoading, setIsAvatarLoading] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  const [messages, setMessages] = useState([]);
  const [isThinking, setIsThinking] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [claudeMode, setClaudeMode] = useState("fallback"); // unknown | live | fallback

  const apiBaseUrl = getApiBaseUrl();
  const suggested = useMemo(
    () => pickRandomQuestions(practiceArea, refreshNonce, 4),
    [practiceArea, refreshNonce]
  );

  const speakFallback = useCallback(
    (text) => {
      if (!("speechSynthesis" in window)) return;
      if (muted) return;

      try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.0;
        u.pitch = 1.0;
        u.volume = 1.0;

        setStatus("speaking");
        u.onend = () => setStatus("ready");
        u.onerror = () => setStatus("ready");
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (e) {
        console.warn("[speech] fallback failed:", e);
        setStatus("ready");
      }
    },
    [muted]
  );

  const inferClaudeMode = useCallback((reply) => {
    const text = String(reply || "").toLowerCase();
    if (!text) return "unknown";
    // Matches our backend fallback templates/messages.
    const isFallback =
      text.includes("this is general information and laws vary by jurisdiction") ||
      text.includes("claude is currently unavailable");
    return isFallback ? "fallback" : "live";
  }, []);

  const handleAsk = useCallback(
    async (messageText) => {
      const normalized =
        typeof messageText === "string"
          ? { text: messageText, files: [] }
          : {
              text: String(messageText?.text || ""),
              files: Array.isArray(messageText?.files) ? messageText.files : [],
            };
      const question = normalized.text.trim();
      if (!question) return;

      setChatError(null);
      setMessages((prev) => [
        ...prev,
        { role: "user", text: question, at: formatNow() },
      ]);

      setIsThinking(true);
      setStatus("thinking");

      const startAttempt = normalized;

      try {
        let chatData = null;
        if (normalized.files.length > 0) {
          const form = new FormData();
          form.append("message", question);
          form.append("practiceArea", practiceArea);
          for (const file of normalized.files) {
            form.append("caseFiles", file);
          }
          const res = await fetch(`${apiBaseUrl}/api/chat`, {
            method: "POST",
            body: form,
          });
          const text = await res.text();
          chatData = text ? JSON.parse(text) : {};
          if (!res.ok) {
            throw new Error(chatData?.error || `Request failed with ${res.status}`);
          }
        } else {
          chatData = await postJson(`${apiBaseUrl}/api/chat`, {
            message: question,
            practiceArea,
          });
        }

        const reply = chatData?.reply;
        if (!reply) throw new Error("Empty Claude reply");
        setClaudeMode(chatData?.mode || inferClaudeMode(reply));

        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: reply, at: formatNow() },
        ]);

        // Speak via LiveAvatar when available; Claude text is the single source of truth.
        if (sessionId) {
          // Lip-sync + gestures are produced by the official LiveAvatar Web SDK.
          try {
            if (liveSessionRef.current) {
              setStatus("speaking");
              liveSessionRef.current.repeat(reply);
              // Safety net: if events don't arrive, return UI to normal.
              if (speakTimeoutRef.current) {
                clearTimeout(speakTimeoutRef.current);
              }
              speakTimeoutRef.current = setTimeout(() => {
                setStatus("ready");
              }, 12000);
            } else {
              speakFallback(reply);
            }
          } catch (avatarErr) {
            console.warn("[avatar] repeat failed:", avatarErr);
            speakFallback(reply);
          }
        } else {
          setStatus("ready");
        }

        setIsThinking(false);
      } catch (err) {
        console.error("[chat] error:", err);
        setIsThinking(false);
        setStatus("ready");
        setChatError({
          message: err?.message || "Sorry—temporary issue. Please try again.",
          canRetry: true,
          onRetry: () => handleAsk(startAttempt),
        });
      }
    },
    [apiBaseUrl, practiceArea, sessionId, speakFallback, inferClaudeMode]
  );

  const onVoiceStatusChange = (nextStatus) => {
    // ChatBox calls this with 'listening'/'ready'
    if (nextStatus === "listening") setStatus("listening");
    if (nextStatus === "ready") setStatus("ready");
  };

  const handlePickSuggested = async (q) => {
    // For a demo, suggested questions submit immediately.
    await handleAsk(q);
  };

  const startSession = useCallback(async () => {
    setAvatarError("");
    setIsAvatarLoading(true);
    try {
      const data = await postJson(
        `${apiBaseUrl}/api/avatar/session`,
        { practiceArea },
        { timeoutMs: 30000 }
      );

      // data.sessionToken is used by LiveAvatar Web SDK.
      const nextSessionId = data?.sessionId || null;
      const sessionToken = data?.sessionToken || null;
      const hasLiveSession = !!sessionToken && !!nextSessionId;
      setSessionId(hasLiveSession ? nextSessionId : null);
      setLiveEnabled(hasLiveSession);
      setStatus("ready");

      if (!sessionToken || !nextSessionId) {
        // No LiveAvatar session token: keep UI usable and show a clear backend reason.
        liveSessionRef.current = null;
        setAvatarError(data?.warning || "LiveAvatar unavailable; using speech fallback.");
        setLiveEnabled(false);
        return;
      }

      // Stop any existing session before starting a new one.
      try {
        await liveSessionRef.current?.stop();
      } catch {
        // ignore
      }
      liveSessionRef.current = null;

      const liveSession = new LiveAvatarSession(sessionToken, {
        // We already do voice recognition separately; disable microphone STT here.
        voiceChat: false,
      });

      liveSession.on(SessionEvent.SESSION_STREAM_READY, () => {
        if (videoRef.current) liveSession.attach(videoRef.current);
      });
      liveSession.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
        setStatus("speaking");
      });
      liveSession.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
        setStatus("ready");
      });
      liveSession.on(SessionEvent.SESSION_DISCONNECTED, () => {
        liveSessionRef.current = null;
        if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
        setStatus("ready");
      });

      await liveSession.start();
      liveSessionRef.current = liveSession;
    } catch (err) {
      console.warn("[avatar] start session failed:", err?.message || err);
      setAvatarError(parseAvatarStartError(err));
      setSessionId(null);
      setLiveEnabled(false);
      liveSessionRef.current = null;
      setStatus("ready");
    } finally {
      setIsAvatarLoading(false);
    }
  }, [apiBaseUrl, practiceArea]);

  const endSession = useCallback(() => {
    try {
      liveSessionRef.current?.stop?.();
    } catch {
      // ignore
    }
    liveSessionRef.current = null;
    if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
    speakTimeoutRef.current = null;
    setSessionId(null);
    setLiveEnabled(false);
    setStatus("ready");
  }, []);

  // Suppress known harmless SDK cleanup rejections when session start fails.
  React.useEffect(() => {
    const onUnhandledRejection = (event) => {
      if (isBenignAvatarCleanupError(event?.reason)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

  return (
    <div className="heroWrap">
      <div className="heroCard">
        <div className="heroInner">
          <div className="left">
            <div className="eyebrow">LawyerAI MERN Demo</div>
            <div
              className="statusBadge"
              style={{
                display: "inline-flex",
                marginBottom: 12,
                borderColor:
                  claudeMode === "live"
                    ? "rgba(52,211,153,0.35)"
                    : claudeMode === "fallback"
                      ? "rgba(251,191,36,0.35)"
                      : "rgba(255,255,255,0.16)",
              }}
              aria-live="polite"
            >
              <span
                className="dot"
                style={{
                  background:
                    claudeMode === "live"
                      ? "#34d399"
                      : claudeMode === "fallback"
                        ? "#f59e0b"
                        : "rgba(255,255,255,0.5)",
                }}
              />
              {claudeMode === "live"
                ? "Claude Live Mode"
                : claudeMode === "fallback"
                  ? "Fallback Mode"
                  : "Claude Status: Unknown"}
            </div>
            <h1>Speak With Our AI Legal Assistant</h1>
            <p className="sub">
              Get instant general legal guidance powered by AI. For case-specific advice,
              book a consultation.
            </p>

            <SuggestedQuestions questions={suggested} onPick={handlePickSuggested} />

            <div className="glass" style={{ padding: 16 }}>
              <ChatBox
                practiceArea={practiceArea}
                onPracticeAreaChange={(v) => setPracticeArea(v)}
                messages={messages}
                onSubmitMessage={handleAsk}
                isThinking={isThinking}
                onVoiceStatusChange={onVoiceStatusChange}
                chatError={chatError}
              />
              <div className="hint" style={{ marginTop: 10 }}>
                This demo provides general information and does not create an attorney-client relationship.
              </div>
            </div>
          </div>

          <div className="right">
            <AvatarPanel
              status={status}
              sessionId={sessionId}
              videoUrl={null}
              muted={muted}
              videoRef={videoRef}
              liveEnabled={liveEnabled}
              isAvatarLoading={isAvatarLoading}
              avatarError={avatarError}
              onStartSession={startSession}
              onToggleMute={() => setMuted((m) => !m)}
              onEndSession={endSession}
            />
            <div className="hint" style={{ marginTop: 14, lineHeight: 1.65 }}>
              Claude generates the reply. LiveAvatar (or a browser fallback) speaks the exact same text with speaking controls.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

