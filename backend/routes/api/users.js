const express = require("express");
const router = express.Router();
const userController = require("../../controllers/userController");
const auth = require("../../middleware/auth");
const { upload } = require("../../middleware/upload");

// 공개 라우트
// 회원가입
router.post("/register", userController.register);

// 인증이 필요한 라우트
// 프로필 조회
router.get("/profile", auth, userController.getProfile);

// 프로필 업데이트
router.put("/profile", auth, userController.updateProfile);

// S3 Presigned URL 생성
router.post(
  "/profile-image/presigned",
  auth,
  userController.generateProfileImageUploadUrl
);

// 이미지 조회용 Presigned URL 생성
// router.get(
//   "/profile-image/read/:imageKey",
//   auth,
//   userController.generateImageReadUrl
// );
// 이미지 조회용 Presigned URL 생성 (슬래시 포함된 키도 매칭)
router.get(
  "/profile-image/read/:imageKey(*)",
  auth,
  userController.generateImageReadUrl
);

// S3 URL을 받아서 프로필 이미지 업데이트
router.post(
  "/profile-image/update",
  auth,
  userController.updateProfileImageFromS3
);

// 기존 프로필 이미지 업로드 (하위 호환성)
router.post(
  "/profile-image",
  auth,
  upload.single("profileImage"),
  userController.uploadProfileImage
);

// 프로필 이미지 삭제
router.delete("/profile-image", auth, userController.deleteProfileImage);

// 회원 탈퇴
router.delete("/account", auth, userController.deleteAccount);

// API 상태 확인
router.get("/status", (req, res) => {
  res.json({
    success: true,
    message: "User API is running",
    timestamp: new Date().toISOString(),
  });
});

// 에러 처리 미들웨어
router.use((err, req, res, next) => {
  console.error("User routes error:", err);

  // Multer 에러 처리
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "파일 크기는 5MB를 초과할 수 없습니다.",
    });
  }

  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      success: false,
      message: "잘못된 파일 필드입니다.",
    });
  }

  // 기타 에러
  res.status(500).json({
    success: false,
    message: "서버 에러가 발생했습니다.",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

module.exports = router;
