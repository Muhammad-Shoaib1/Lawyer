import React, { useEffect } from "react";
import StatusBadge from "./StatusBadge.jsx";

export default function AvatarPanel({
  status,
  sessionId,
  videoUrl,
  videoRef,
  liveEnabled,
  muted,
  onStartSession,
  onToggleMute,
  onEndSession,
  isAvatarLoading,
  avatarError,
}) {
  useEffect(() => {
    if (videoRef?.current) videoRef.current.muted = !!muted;
  }, [muted, videoRef]);

  // In LiveAvatar WebSDK the video element is fed via WebRTC tracks,
  // so we render the <video> whenever a session exists.
  const hasVideo = !!sessionId && !!liveEnabled;
  const hasSession = !!sessionId;

  return (
    <div>
      <div className="rightTop">
        <StatusBadge status={status} />
      </div>

      <div className="glass videoCard">
        <div className="videoFrame">
          {hasVideo ? (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              controls={false}
              muted={muted}
              aria-label="Live avatar video"
            />
          ) : (
            <div style={{ padding: 18 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>
                  {hasSession ? "Speech fallback active" : "Avatar not started"}
                </div>
                <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.6 }}>
                  {hasSession
                    ? "LiveAvatar video isn’t available right now, but your assistant will still speak the Claude reply."
                    : "Click "}
                  {hasSession ? null : (
                    <>
                      Click{" "}
                      <span style={{ color: "rgba(217,180,90,0.95)", fontWeight: 900 }}>
                        Start Session
                      </span>{" "}
                      to begin.
                    </>
                  )}
                </div>
            </div>
          )}

          <div className="videoOverlay">
            {status === "speaking" ? (
              <div className="speakingHint gestureBadge">Speaking with gestures</div>
            ) : (
              <div className="gestureBadge">LiveAvatar panel</div>
            )}
            <div className="gestureBadge" style={{ maxWidth: 220 }}>
              {sessionId ? `Session: ${sessionId}` : "No session"}
            </div>
          </div>
        </div>

        {avatarError ? (
          <div style={{ marginTop: 12, color: "rgba(255,255,255,0.85)", fontSize: 13 }}>
            {avatarError}
          </div>
        ) : null}

        <div className="smallRow" style={{ marginTop: 14 }}>
          <button
            className="btn btnGold"
            type="button"
            disabled={isAvatarLoading}
            onClick={onStartSession}
          >
            Start Session
          </button>
          <button
            className="btn"
            type="button"
            disabled={!sessionId}
            onClick={onToggleMute}
          >
            {muted ? "Unmute" : "Mute"}
          </button>
          <button
            className="btn"
            type="button"
            disabled={!sessionId}
            onClick={onEndSession}
          >
            End Session
          </button>
        </div>
      </div>
    </div>
  );
}

