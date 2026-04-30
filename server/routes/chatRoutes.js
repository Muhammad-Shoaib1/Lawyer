const express = require("express");
const { chatController } = require("../controllers/chatController");
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

module.exports = router;

