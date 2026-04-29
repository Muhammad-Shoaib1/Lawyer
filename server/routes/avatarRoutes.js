const express = require("express");
const avatarController = require("../controllers/avatarController");

const router = express.Router();

// POST /api/avatar/session
router.post("/avatar/session", avatarController.createSession);

// POST /api/avatar/speak
router.post("/avatar/speak", avatarController.speak);

module.exports = router;

