import React from "react";

export default function SuggestedQuestions({ questions, onPick }) {
  return (
    <div className="suggestedGrid" role="group" aria-label="Suggested questions">
      {questions.map((q) => (
        <button
          key={q}
          className="pillBtn"
          type="button"
          onClick={() => onPick(q)}
        >
          {q}
        </button>
      ))}
    </div>
  );
}

