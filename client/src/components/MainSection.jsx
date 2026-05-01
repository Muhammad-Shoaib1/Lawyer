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
  if (url) {
    console.log("[config] Using VITE_API_BASE_URL:", url);
    return url;
  }
  
  // If running on Vercel and no API URL is set, assume same origin /api
  if (typeof window !== "undefined" && window.location.hostname.includes("vercel.app")) {
    console.log("[config] Detected Vercel environment, using relative path for API.");
    return ""; // Relative path
  }
  
  console.log("[config] Falling back to localhost:5000 for API.");
  return "http://localhost:5000";
}

function parseAvatarStartError(err) {
  const raw = String(err?.message || err || "").toLowerCase();

  if (raw.includes("insufficient credits") || raw.includes("no credits") || raw.includes("credit limit")) {
    return "Your HeyGen/LiveAvatar account has no credits available. Please top up your credits to enable the live avatar.";
  }
  if (raw.includes("forbidden") || raw.includes("403") || raw.includes("authorized")) {
    return "LiveAvatar rejected the session (403/Unauthorized). Please check your API key permissions and avatar access.";
  }
  return `Live avatar session failed: ${raw || "Unknown error"}. Using speech fallback.`;
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
  const [mood, setMood] = useState("Supportive"); // Supportive | Challenging | Hostile

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
    async (messageText) => {
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

      setIsThinking(true);
      setStatus("thinking");

      // Perfectly Real-Time: Immediate filler speech based on mood
      if (sessionId && liveSessionRef.current) {
        const fillers = {
          Supportive: [
            "I understand. Let me look into that for you right away...",
            "I'm here to help. One moment while I check the legal details...",
            "That's a valid concern. Let me analyze this for you..."
          ],
          Challenging: [
            "That's a bold claim. Let's see what the law actually says...",
            "I'll need to scrutinize that position. One moment...",
            "Are you sure about that? Let me verify the statutes..."
          ],
          Hostile: [
            "Wait right there. Let me see what the law says about your situation...",
            "This doesn't look promising for you. Let me pull up the relevant laws...",
            "Hold on. I'll need to check the exact wording of the law on this..."
          ]
        };
        const moodFillers = fillers[mood] || fillers.Supportive;
        const filler = moodFillers[Math.floor(Math.random() * moodFillers.length)];
        console.log(`[avatar] Speaking filler (${mood}):`, filler);
        try {
          liveSessionRef.current.repeat(filler);
        } catch (e) {
          console.warn("[avatar] Filler speech failed:", e);
        }
      }

      try {
        console.log(`[chat] Requesting Claude stream (Mood: ${mood})...`);
        let res;
        const body = { message: question, mood };
        if (normalized.files.length > 0) {
          const form = new FormData();
          form.append("message", question);
          form.append("mood", mood);
          for (const file of normalized.files) {
            form.append("caseFiles", file);
          }
          res = await fetch(`${apiBaseUrl}/api/chat-stream`, {
            method: "POST",
            body: form,
          });
        } else {
          res = await fetch(`${apiBaseUrl}/api/chat-stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        }

        console.log("[chat] Response status:", res.status, res.headers.get("Content-Type"));

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Stream request failed: ${res.status} - ${errorText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let fullReply = "";
        let buffer = "";

        // Add placeholder assistant message
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "", at: formatNow() },
        ]);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          console.log("[chat] Raw chunk received:", chunk);
          buffer += chunk;

          const lines = buffer.split("\n");
          // Keep the last partial line in the buffer
          buffer = lines.pop();

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

            const dataStr = trimmedLine.slice(6).trim();
            if (dataStr === "[DONE]") {
              console.log("[chat] DONE signal received.");
              break;
            }

            try {
              const data = JSON.parse(dataStr);
              if (data.text) {
                fullReply += data.text;
                // Update the last message in state
                setMessages((prev) => {
                  const next = [...prev];
                  const lastIdx = next.length - 1;
                  if (next[lastIdx] && next[lastIdx].role === "assistant") {
                    next[lastIdx] = { ...next[lastIdx], text: fullReply };
                  }
                  return next;
                });
              }
            } catch (e) {
              console.error("[chat] Failed to parse SSE data:", dataStr, e);
            }
          }
        }

        console.log("[chat] Stream fully completed. Final length:", fullReply.length);
        setIsThinking(false);

        // Speak via LiveAvatar when available
        if (sessionId && fullReply) {
          try {
            if (liveSessionRef.current) {
              setStatus("speaking");
              liveSessionRef.current.repeat(fullReply);
              if (speakTimeoutRef.current) clearTimeout(speakTimeoutRef.current);
              speakTimeoutRef.current = setTimeout(() => setStatus("ready"), 12000);
            } else {
              speakFallback(fullReply);
            }
          } catch (avatarErr) {
            console.warn("[avatar] repeat failed:", avatarErr);
            speakFallback(fullReply);
          }
        } else {
          setStatus("ready");
        }
      } catch (err) {
        console.error("[chat] Stream error:", err);
        setLastClaudeError(err?.message || "Streaming error");
        setIsThinking(false);
        setStatus("ready");
        setChatError({
          message: "Connection lost. Please try again.",
          canRetry: true,
          onRetry: () => handleAsk(messageText),
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

            <div className="moodSelector" style={{ marginBottom: 16, display: "flex", gap: 8 }}>
              {["Supportive", "Challenging", "Hostile"].map((m) => (
                <button
                  key={m}
                  onClick={() => setMood(m)}
                  className={`moodBtn ${mood === m ? "active" : ""}`}
                  style={{
                    background: mood === m ? "rgba(217,180,90,0.25)" : "rgba(255,255,255,0.05)",
                    color: mood === m ? "var(--gold)" : "rgba(255,255,255,0.6)",
                    border: `1px solid ${mood === m ? "var(--gold)" : "rgba(255,255,255,0.1)"}`,
                    padding: "6px 12px",
                    borderRadius: "10px",
                    fontSize: "13px",
                    cursor: "pointer",
                    transition: "all 0.3s ease"
                  }}
                >
                  {m}
                </button>
              ))}
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

