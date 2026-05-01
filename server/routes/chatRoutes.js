const express = require("express");
const { chatController, chatStreamController } = require("../controllers/chatController");
const multer = require("multer");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 2 * 1024 * 1024,
  },
});

// POST /api/chat
router.post("/chat", upload.array("caseFiles", 5), chatController);

// POST /api/chat-stream
router.post("/chat-stream", upload.array("caseFiles", 5), chatStreamController);

module.exports = router;

