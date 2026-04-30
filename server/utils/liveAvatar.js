function makeMockSessionId() {
  return `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function safeString(v) {
  return typeof v === "string" ? v : undefined;
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    if (obj[k]) return obj[k];
  }
  return undefined;
}

function dedupeNonEmpty(values) {
  return Array.from(new Set(values.map((v) => safeString(v)?.trim()).filter(Boolean)));
}

async function jsonRequest(
  url,
  { method = "POST", headers = {}, body, timeoutMs = 7000 } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  });
  try {
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(
        `LiveAvatar request failed (${res.status}): ${JSON.stringify(
          data?.error || data?.message || data?.raw || {}
        )}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (err) {
    const aborted = err?.name === "AbortError";
    if (aborted) {
      const timeoutErr = new Error(
        `LiveAvatar request timed out after ${timeoutMs}ms.`
      );
      timeoutErr.code = "LIVEAVATAR_TIMEOUT";
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function buildHeaders(apiKey) {
  // LiveAvatar API docs use X-API-KEY for session token creation.
  return {
    "Content-Type": "application/json",
    "X-API-KEY": apiKey,
  };
}

async function createLiveAvatarSessionToken({
  apiKey,
  baseUrl,
  avatarId,
}) {
  if (!apiKey || !avatarId) {
    return {
      isMock: true,
      sessionId: makeMockSessionId(),
      sessionToken: null,
      reason: "Missing LiveAvatar environment variables.",
    };
  }

  const requestTimeoutMs = Math.max(
    1500,
    Number(process.env.LIVEAVATAR_TOKEN_TIMEOUT_MS || 7000)
  );
  const fallbackUrlsEnabled = String(
    process.env.LIVEAVATAR_ENABLE_FALLBACK_URLS || "false"
  ).toLowerCase() === "true";

  // Fast path: configured URL first. Optional fallback URLs can be enabled explicitly.
  const candidates = fallbackUrlsEnabled
    ? dedupeNonEmpty([baseUrl, "https://api.liveavatar.com", "https://api.liveavatar.ai"])
    : dedupeNonEmpty([baseUrl || "https://api.liveavatar.com"]);

  const errors = [];

  for (const candidateBaseUrl of candidates) {
    try {
      const url = new URL("/v1/sessions/token", candidateBaseUrl).toString();

      // Full mode token: avatar_persona is required by schema (object even if minimal).
      const body = {
        mode: "FULL",
        avatar_id: avatarId,
        avatar_persona: {
          language: "en",
        },
      };

      const data = await jsonRequest(url, {
        headers: buildHeaders(apiKey),
        body,
        timeoutMs: requestTimeoutMs,
      });

      const payload = data?.data || data;

      const sessionId = pickFirst(payload, ["session_id", "sessionId", "id"]);
      const sessionToken = pickFirst(payload, [
        "session_token",
        "sessionToken",
      ]);

      if (!sessionId || !sessionToken) {
        throw new Error("Missing session_id/session_token in LiveAvatar response.");
      }

      return { isMock: false, sessionId, sessionToken };
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }

  return {
    isMock: true,
    sessionId: makeMockSessionId(),
    sessionToken: null,
    reason: `Unable to create LiveAvatar session token: ${errors.join(" | ")}`,
  };
}

module.exports = { createLiveAvatarSessionToken };

