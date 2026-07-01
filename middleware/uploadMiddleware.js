// middleware/uploadMiddleware.js

const fs = require("fs");
const path = require("path");
const multer = require("multer");

const userUploadDir = path.join(__dirname, "..", "public", "uploads", "users");

if (!fs.existsSync(userUploadDir)) {
  fs.mkdirSync(userUploadDir, { recursive: true });
}

const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];

const userPhotoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, userUploadDir);
  },

  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const userId = req.user?._id || req.session?.user?._id || "user";

    cb(null, `${userId}-${Date.now()}${ext}`);
  },
});

function imageFileFilter(req, file, cb) {
  if (!allowedImageTypes.includes(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, and WEBP images are allowed."));
  }

  cb(null, true);
}

const uploadUserPhoto = multer({
  storage: userPhotoStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

module.exports = {
  uploadUserPhoto,
};
