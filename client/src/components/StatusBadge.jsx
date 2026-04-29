import React from "react";

export default function StatusBadge({ status }) {
  const normalized = (status || "Ready").toLowerCase();

  const label =
    normalized === "ready"
      ? "Ready"
      : normalized === "listening"
        ? "Listening"
        : normalized === "thinking"
          ? "Thinking"
          : normalized === "speaking"
            ? "Speaking"
            : status || "Ready";

  const className =
    normalized === "ready"
      ? "statusBadge statusReady"
      : normalized === "listening"
        ? "statusBadge statusListening"
        : normalized === "thinking"
          ? "statusBadge statusThinking"
          : normalized === "speaking"
            ? "statusBadge statusSpeaking"
            : "statusBadge";

  return (
    <div className={className} aria-live="polite">
      <span className="dot" />
      {label}
    </div>
  );
}

