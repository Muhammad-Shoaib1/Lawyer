import React, { useCallback, useMemo, useRef, useState } from "react";
import ChatBox from "./ChatBox.jsx";

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
  const url = import.meta.env.VITE_API_BASE_URL;
  if (url) return url;
  
  // If running on Vercel and no API URL is set, assume same origin /api
  if (typeof window !== "undefined" && window.location.hostname.includes("vercel.app")) {
    return ""; // Relative path
  }
  
  return "http://localhost:5000";
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
  const [lastClaudeError, setLastClaudeError] = useState("");

  const apiBaseUrl = getApiBaseUrl();
  console.log("[MainSection] Initialized. API Base URL:", apiBaseUrl);


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

  const stopSpeakingNow = useCallback(() => {
    try {
      window.speechSynthesis?.cancel?.();
    } catch {
      // ignore
    }
    const live = liveSessionRef.current;
    if (live) {
      try {
        live.interrupt?.();
        live.stopSpeaking?.();
        live.stopAvatar?.();
      } catch {
        // best effort
      }
    }
    setStatus("listening");
  }, []);

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
      console.log("[chat] Handling question:", messageText);
      const normalized =
        typeof messageText === "string"
          ? { text: messageText, files: [] }
          : {
              text: String(messageText?.text || ""),
              files: Array.isArray(messageText?.files) ? messageText.files : [],
            };
      const question = normalized.text.trim();
      if (!question) {
        console.warn("[chat] Empty question, skipping.");
        return;
      }

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
          console.log("[chat] Requesting Claude reply (no files)...");
          chatData = await postJson(`${apiBaseUrl}/api/chat`, {
            message: question,
          });
        }
        console.log("[chat] Received response:", chatData);

        const reply = chatData?.reply;
        if (!reply) throw new Error("Empty Claude reply");
        const nextMode = inferClaudeMode(reply);
        if (nextMode === "fallback") {
          console.warn(`[claude] Fallback mode active. ${chatData?.modeReason || ""}`);
        }
        setClaudeMode(nextMode);
        setLastClaudeError(nextMode === "fallback" ? chatData?.modeReason || "" : "");

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
        setLastClaudeError(err?.message || "Unknown chat error");
        setIsThinking(false);
        setStatus("ready");
        setChatError({
          message: err?.message || "Sorry—temporary issue. Please try again.",
          canRetry: true,
          onRetry: () => handleAsk(startAttempt),
        });
      }
    },
    [apiBaseUrl, sessionId, speakFallback, inferClaudeMode]
  );

  const onVoiceStatusChange = (nextStatus) => {
    // ChatBox calls this with 'listening'/'ready'
    if (nextStatus === "listening") setStatus("listening");
    if (nextStatus === "ready") setStatus("ready");
  };



  const downloadConversation = useCallback(() => {
    const lines = [];
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");
    for (const m of messages) {
      const who = m.role === "user" ? "You" : "Assistant";
      lines.push(`[${who}] ${new Date(m.at).toLocaleString()}`);
      lines.push(String(m.text || ""));
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lawyerai-conversation-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  const startSession = useCallback(async () => {
    console.log("[avatar] Starting session...");
    setAvatarError("");
    setIsAvatarLoading(true);
    try {
      const data = await postJson(
        `${apiBaseUrl}/api/avatar/session`,
        {},
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
        console.log("[avatar] Stream ready.");
        if (videoRef.current) liveSession.attach(videoRef.current);
      });
      liveSession.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        console.log("[avatar] Speaking started.");
        if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
        setStatus("speaking");
      });
      liveSession.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        console.log("[avatar] Speaking ended.");
        if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
        setStatus("ready");
      });
      liveSession.on(SessionEvent.SESSION_DISCONNECTED, () => {
        console.log("[avatar] Disconnected.");
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
  }, [apiBaseUrl]);

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

  // Auto-start session on mount
  React.useEffect(() => {
    console.log("[MainSection] Auto-starting avatar session...");
    startSession();
  }, [startSession]);

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
            <div
              className="statusBadge"
              style={{
                display: "inline-flex",
                marginBottom: 12,
                borderColor: "rgba(52,211,153,0.35)",
              }}
              aria-live="polite"
            >
              <span
                className="dot"
                style={{
                  background: "#34d399",
                }}
              />
              Claude Active
            </div>



            <div className="glass" style={{ padding: 16 }}>
              <ChatBox
                messages={messages}
                onSubmitMessage={handleAsk}
                isThinking={isThinking}
                onVoiceStatusChange={onVoiceStatusChange}
                onBargeInDetected={stopSpeakingNow}
                status={status}
                chatError={chatError}
                onDownloadConversation={downloadConversation}
              />

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
              onStopSpeaking={stopSpeakingNow}
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

