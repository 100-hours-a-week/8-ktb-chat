const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { upload } = require("../middleware/upload");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const { s3Client } = require("../config/s3");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 검증
    const validationErrors = [];

    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: "name",
        message: "이름을 입력해주세요.",
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: "name",
        message: "이름은 2자 이상이어야 합니다.",
      });
    }

    if (!email) {
      validationErrors.push({
        field: "email",
        message: "이메일을 입력해주세요.",
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: "email",
        message: "올바른 이메일 형식이 아닙니다.",
      });
    }

    if (!password) {
      validationErrors.push({
        field: "password",
        message: "비밀번호를 입력해주세요.",
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: "password",
        message: "비밀번호는 6자 이상이어야 합니다.",
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors,
      });
    }

    // 사용자 중복 확인
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "이미 가입된 이메일입니다.",
      });
    }

    // 비밀번호 암호화 및 사용자 생성
    const newUser = new User({
      name,
      email,
      password,
      profileImage: "", // 기본 프로필 이미지 없음
    });

    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    res.status(201).json({
      success: true,
      message: "회원가입이 완료되었습니다.",
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({
      success: false,
      message: "회원가입 처리 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 조회 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 업데이트
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "이름을 입력해주세요.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    user.name = name.trim();
    await user.save();

    res.json({
      success: true,
      message: "프로필이 업데이트되었습니다.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 업데이트 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 이미지 업로드
exports.uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "이미지가 제공되지 않았습니다.",
      });
    }

    // 파일 유효성 검사
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: "파일 크기는 5MB를 초과할 수 없습니다.",
      });
    }

    if (!fileType.startsWith("image/")) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(400).json({
        success: false,
        message: "이미지 파일만 업로드할 수 있습니다.",
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      // 업로드된 파일 삭제
      await fs.unlink(req.file.path);
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 기존 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const oldImagePath = path.join(__dirname, "..", user.profileImage);
      try {
        await fs.access(oldImagePath);
        await fs.unlink(oldImagePath);
      } catch (error) {
        console.error("Old profile image delete error:", error);
      }
    }

    // 새 이미지 경로 저장
    const imageUrl = `/uploads/${req.file.filename}`;
    user.profileImage = imageUrl;
    await user.save();

    res.json({
      success: true,
      message: "프로필 이미지가 업데이트되었습니다.",
      imageUrl: user.profileImage,
    });
  } catch (error) {
    console.error("Profile image upload error:", error);
    // 업로드 실패 시 파일 삭제
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch (unlinkError) {
        console.error("File delete error:", unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: "이미지 업로드 중 오류가 발생했습니다.",
    });
  }
};

// 프로필 이미지 삭제
exports.deleteProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    if (user.profileImage) {
      const imagePath = path.join(__dirname, "..", user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error("Profile image delete error:", error);
      }

      user.profileImage = "";
      await user.save();
    }

    res.json({
      success: true,
      message: "프로필 이미지가 삭제되었습니다.",
    });
  } catch (error) {
    console.error("Delete profile image error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 이미지 삭제 중 오류가 발생했습니다.",
    });
  }
};

// 회원 탈퇴
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 프로필 이미지가 있다면 삭제
    if (user.profileImage) {
      const imagePath = path.join(__dirname, "..", user.profileImage);
      try {
        await fs.access(imagePath);
        await fs.unlink(imagePath);
      } catch (error) {
        console.error("Profile image delete error:", error);
      }
    }

    await user.deleteOne();

    res.json({
      success: true,
      message: "회원 탈퇴가 완료되었습니다.",
    });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({
      success: false,
      message: "회원 탈퇴 처리 중 오류가 발생했습니다.",
    });
  }
};

// S3 Presigned URL 생성 API
exports.generateProfileImageUploadUrl = async (req, res) => {
  try {
    const { filename, contentType } = req.body;

    // 입력값 검증
    if (!filename || !contentType) {
      return res.status(400).json({
        success: false,
        message: "파일명과 콘텐츠 타입이 필요합니다.",
      });
    }

    if (!contentType.startsWith("image/")) {
      return res.status(400).json({
        success: false,
        message: "이미지 파일만 업로드할 수 있습니다.",
      });
    }

    const allowedExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const ext = path.extname(filename).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      return res.status(400).json({
        success: false,
        message: "지원하지 않는 이미지 형식입니다.",
      });
    }

    // 사용자별 경로 지정
    const s3Key = `profile-images/${req.user.id}/${Date.now()}-${filename}`;

    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
      ContentType: contentType,
      // ACL 제거 → AccessDenied 방지
      Metadata: {
        userId: req.user.id,
        uploadedAt: new Date().toISOString(),
      },
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    res.json({
      success: true,
      presignedUrl,
      s3Key,
      filename,
      contentType,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error("Generate S3 presigned URL error:", error);
    res.status(500).json({
      success: false,
      message: "Presigned URL 생성 중 오류가 발생했습니다.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// S3 URL을 받아서 사용자 프로필 업데이트
exports.updateProfileImageFromS3 = async (req, res) => {
  try {
    const { s3Url, s3Key } = req.body;

    // 입력값 검증
    if (!s3Url || !s3Key) {
      return res.status(400).json({
        success: false,
        message: "S3 URL과 키가 필요합니다.",
      });
    }

    // S3 URL 형식 검증
    if (
      !s3Url.startsWith("https://") ||
      !s3Url.includes(process.env.S3_BUCKET_NAME)
    ) {
      return res.status(400).json({
        success: false,
        message: "잘못된 S3 URL입니다.",
      });
    }

    // 사용자 정보 가져오기
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "사용자를 찾을 수 없습니다.",
      });
    }

    // 기존 프로필 이미지가 S3에 있다면 삭제 (선택사항)
    if (
      user.profileImage &&
      user.profileImage.includes(process.env.S3_BUCKET_NAME)
    ) {
      try {
        const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
        const deleteCommand = new DeleteObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: user.profileImage.split("/").slice(-2).join("/"), // profile-images/userId/filename
        });
        await s3Client.send(deleteCommand);
      } catch (error) {
        console.error("Old S3 image delete error:", error);
        // 삭제 실패해도 계속 진행
      }
    }

    // 새 S3 URL 저장
    user.profileImage = s3Url;
    await user.save();

    res.json({
      success: true,
      message: "프로필 이미지가 업데이트되었습니다.",
      imageUrl: user.profileImage,
    });
  } catch (error) {
    console.error("Update profile image from S3 error:", error);
    res.status(500).json({
      success: false,
      message: "프로필 이미지 업데이트 중 오류가 발생했습니다.",
    });
  }
};

// 이미지 조회용 Presigned URL 생성
exports.generateImageReadUrl = async (req, res) => {
  try {
    const { imageKey } = req.params;
    if (!imageKey) {
      return res.status(400).json({
        success: false,
        message: "이미지 키가 필요합니다.",
      });
    }

    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: decodeURIComponent(imageKey),
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    res.json({
      success: true,
      imageUrl: presignedUrl,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error("Generate image read URL error:", error);
    res.status(500).json({
      success: false,
      message: "이미지 URL 생성 중 오류가 발생했습니다.",
    });
  }
};

module.exports = exports;
