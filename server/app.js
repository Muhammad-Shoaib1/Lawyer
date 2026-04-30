const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const chatRoutes = require("./routes/chatRoutes");
const avatarRoutes = require("./routes/avatarRoutes");
const { notFoundHandler } = require("./middleware/errorHandler");

const app = express();

app.use(helmet());
app.use(cors({
  origin: ["https://project-zyhhm.vercel.app", "http://localhost:5173"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));
app.use(morgan("dev"));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", chatRoutes);
app.use("/api", avatarRoutes);

// Friendly health/info endpoint for quick manual checks.
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    routes: {
      chat: "POST /api/chat",
      avatarSession: "POST /api/avatar/session",
      avatarSpeak: "POST /api/avatar/speak",
    },
  });
});

app.use(notFoundHandler);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
  });
});

module.exports = app;

