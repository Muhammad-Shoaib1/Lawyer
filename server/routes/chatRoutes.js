const express = require("express");
const {
  chatController,
  chatStreamController,
  endSessionReportController,
} = require("../controllers/chatController");
const multer = require("multer");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024, // Increased to 10MB
  },
});

// POST /api/chat
router.post("/chat", upload.array("caseFiles", 5), chatController);

// POST /api/chat-stream
router.post("/chat-stream", upload.array("caseFiles", 5), chatStreamController);
router.post("/end-session-report", express.json({ limit: "2mb" }), endSessionReportController);

module.exports = router;

