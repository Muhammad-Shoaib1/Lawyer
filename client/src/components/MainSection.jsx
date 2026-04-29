import React, { useCallback, useMemo, useRef, useState } from "react";
import ChatBox from "./ChatBox.jsx";
import SuggestedQuestions from "./SuggestedQuestions.jsx";
import AvatarPanel from "./AvatarPanel.jsx";
import {
  LiveAvatarSession,
  SessionEvent,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk";

function formatNow() {
  return new Date();
}

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
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
  const suggested = useMemo(
    () => [
      "What should I do after a car accident?",
      "How does divorce filing begin?",
      "Can I get bail quickly?",
      "What documents should I bring?",
    ],
    []
  );

  const [practiceArea, setPracticeArea] = useState("Family Law");
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

  const apiBaseUrl = getApiBaseUrl();

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

  const handleAsk = useCallback(
    async (messageText) => {
      const question = messageText.trim();
      if (!question) return;

      setChatError(null);
      setMessages((prev) => [
        ...prev,
        { role: "user", text: question, at: formatNow() },
      ]);

      setIsThinking(true);
      setStatus("thinking");

      const startAttempt = question;

      try {
        const chatData = await postJson(`${apiBaseUrl}/api/chat`, {
          message: question,
          practiceArea,
        });

        const reply = chatData?.reply;
        if (!reply) throw new Error("Empty Claude reply");

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
    [apiBaseUrl, practiceArea, sessionId, speakFallback]
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

      setSessionId(nextSessionId);
      setLiveEnabled(!!sessionToken && !!nextSessionId);
      setStatus("ready");

      if (!sessionToken || !nextSessionId) {
        // No LiveAvatar session token: keep the UI usable with browser fallback.
        liveSessionRef.current = null;
        if (data?.warning) setAvatarError(data.warning);
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
      console.error("[avatar] start session failed:", err);
      setAvatarError(err?.message || "Avatar unavailable.");
      setSessionId(null);
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

  return (
    <div className="heroWrap">
      <div className="heroCard">
        <div className="heroInner">
          <div className="left">
            <div className="eyebrow">LawyerAI MERN Demo</div>
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

