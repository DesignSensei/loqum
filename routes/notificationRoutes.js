// routes/notificationRoutes.js

const express = require("express");
const router = express.Router();

const { isAuthenticated } = require("../middleware/authMiddleware");

const notificationController = require("../controllers/notificationController");

router.use(isAuthenticated);

router.post("/read-all", notificationController.markAllNotificationsAsRead);

router.post("/:notificationId/read", notificationController.markNotificationAsRead);

module.exports = router;
