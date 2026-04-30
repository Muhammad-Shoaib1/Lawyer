const AvatarSession = require("../models/AvatarSession");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const { createLiveAvatarSessionToken } = require("../utils/liveAvatar");
const mongoose = require("mongoose");

function getUserAgent(req) {
  return (
    req.headers["user-agent"] ||
    req.headers["User-Agent"] ||
    "unknown-user-agent"
  );
}

async function createSession(req, res) {
  const { practiceArea } = req.body || {};
  const area = typeof practiceArea === "string" ? practiceArea : "General";

  const startTs = Date.now();
  try {
    const result = await createLiveAvatarSessionToken({
      apiKey: process.env.LIVEAVATAR_API_KEY,
      baseUrl: process.env.LIVEAVATAR_BASE_URL,
      avatarId: process.env.LIVEAVATAR_AVATAR_ID,
    });
    const isMock = !!result?.isMock;
    const warning = isMock
      ? result?.reason || "LiveAvatar unavailable; using speech fallback."
      : null;

    // MongoDB is optional for the demo; only log when connected.
    if (mongoose.connection.readyState === 1) {
      try {
        await AvatarSession.create({
          sessionId: result.sessionId,
          sessionToken: result.sessionToken,
          practiceArea: area,
          status: isMock ? "mock_ready" : "ready",
          lastActivityAt: new Date(),
          meta: { userAgent: getUserAgent(req) },
        });
      } catch (dbErr) {
        console.warn("[mongo] failed saving avatar session:", dbErr?.message);
      }

      try {
        await AnalyticsEvent.create({
          practiceArea: area,
          route: "/api/avatar/session",
          eventType: "avatar_session_create",
          success: !isMock,
          error: isMock ? warning : null,
          sessionId: result.sessionId,
          meta: { latencyMs: Date.now() - startTs },
        });
      } catch (dbErr) {
        console.warn("[mongo] failed saving avatar analytics:", dbErr?.message);
      }
    }

    return res.json({
      sessionId: result.sessionId,
      sessionToken: result.sessionToken,
      isMock,
      warning,
    });
  } catch (err) {
    console.error("[avatar] createSession failed:", err?.message || err);
    const latencyMs = Date.now() - startTs;

    // Demo resilience: even if LiveAvatar can't create a session,
    // return a mock sessionId so the frontend can still do browser fallback speech.
    const mockSessionId = `mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    try {
      await AnalyticsEvent.create({
        practiceArea: area,
        route: "/api/avatar/session",
        eventType: "avatar_session_create",
        success: false,
        error: err?.message || "unknown error",
        sessionId: mockSessionId,
        meta: { latencyMs },
      });
    } catch {
      // ignore db failures
    }

    if (mongoose.connection.readyState === 1) {
      try {
        await AvatarSession.create({
          sessionId: mockSessionId,
          sessionToken: null,
          practiceArea: area,
          status: "mock_ready",
          lastActivityAt: new Date(),
          meta: { userAgent: getUserAgent(req) },
        });
      } catch (dbErr) {
        console.warn("[mongo] failed saving mock avatar session:", dbErr?.message);
      }
    }

    return res.json({
      sessionId: mockSessionId,
      sessionToken: null,
      isMock: true,
      warning: "LiveAvatar unavailable; using speech fallback.",
    });
  }
}

async function speak(req, res) {
  const { sessionId, text, practiceArea } = req.body || {};
  const area = typeof practiceArea === "string" ? practiceArea : "General";

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  const startTs = Date.now();

  // Speaking is now controlled client-side via the official LiveAvatar web SDK
  // (LiveKit WebRTC with lip-sync). We keep this endpoint for compatibility.
  try {
    await AnalyticsEvent.create({
      practiceArea: area,
      route: "/api/avatar/speak",
      eventType: "avatar_speak_compat",
      success: false,
      error: "Client-side speaking via LiveAvatar SDK",
      sessionId,
      meta: { latencyMs: Date.now() - startTs },
    });
  } catch {
    // ignore db failures
  }

  return res.json({
    ok: false,
    fallbackSpeech: true,
    reason: "LiveAvatar speaking is handled client-side via SDK.",
  });
}

module.exports = { createSession, speak };

