import React, { useState, useEffect, useCallback, forwardRef } from "react";
import { Avatar } from "@vapor-ui/core";
import { getConsistentAvatarStyles } from "../../utils/colorUtils";
import {
  getImageReadUrl,
  extractImageKeyFromS3Url,
} from "../../services/fileService";

const PersistentAvatar = forwardRef(
  (
    {
      user,
      size = "md",
      className = "",
      onClick,
      showInitials = true,
      ...props
    },
    ref
  ) => {
    const [currentImage, setCurrentImage] = useState("");
    const [imageError, setImageError] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // getProfileImageUrl 함수 memoization
    const getProfileImageUrl = useCallback((imagePath) => {
      if (!imagePath) return null;
      return imagePath.startsWith("http")
        ? imagePath
        : `${process.env.NEXT_PUBLIC_API_URL}${imagePath}`;
    }, []);

    // S3 이미지 처리를 위한 presigned URL 요청
    const handleS3ImageError = async (s3Url) => {
      try {
        setIsLoading(true);
        console.log("Attempting to get presigned URL for S3 image:", s3Url);

        // S3 키 추출
        const s3Key = extractImageKeyFromS3Url(s3Url);
        console.log("Extracted S3 key:", s3Key);

        if (s3Key && user?.token) {
          // Presigned GET URL 요청
          const presignedUrl = await getImageReadUrl(
            s3Key,
            user.token,
            user.sessionId
          );
          console.log("Got presigned URL:", presignedUrl);
          setCurrentImage(presignedUrl);
          setImageError(false);
        }
      } catch (error) {
        console.error("Failed to get presigned URL:", error);
        setImageError(true);
      } finally {
        setIsLoading(false);
      }
    };

    // 프로필 이미지 URL 처리
    useEffect(() => {
      // 1) 프로필 이미지 키가 없으면 빈 상태
      if (!user?.profileImage) {
        setCurrentImage("");
        return;
      }
      // 2) S3 키(“profile-images/...”) 형태면 바로 Presigned GET URL 요청
      if (user.profileImage.startsWith("profile-images/") && user?.token) {
        setIsLoading(true);
        getImageReadUrl(user.profileImage, user.token, user.sessionId)
          .then((url) => {
            setCurrentImage(url);
            setImageError(false);
          })
          .catch(() => {
            setImageError(true);
          })
          .finally(() => setIsLoading(false));
      }
      // 3) 아니면 plain URL (예: 외부 CDN) 그대로 사용
      else {
        setCurrentImage(getProfileImageUrl(user.profileImage));
        setImageError(false);
      }
    }, [user?.profileImage, getProfileImageUrl, currentImage]);

    // 전역 프로필 업데이트 리스너
    useEffect(() => {
      const handleProfileUpdate = () => {
        try {
          const updatedUser = JSON.parse(localStorage.getItem("user") || "{}");
          // 현재 사용자의 프로필이 업데이트된 경우에만 이미지 업데이트
          if (
            user?.id === updatedUser.id &&
            updatedUser.profileImage !== user.profileImage
          ) {
            const newImageUrl = getProfileImageUrl(updatedUser.profileImage);
            setImageError(false);
            setCurrentImage(newImageUrl);
          }
        } catch (error) {
          console.error("Profile update handling error:", error);
        }
      };

      window.addEventListener("userProfileUpdate", handleProfileUpdate);
      return () => {
        window.removeEventListener("userProfileUpdate", handleProfileUpdate);
      };
    }, [getProfileImageUrl, user?.id, user?.profileImage]);

    // 이메일 기반의 일관된 스타일 가져오기
    const avatarStyles = getConsistentAvatarStyles(user?.email);

    const handleImageError = async (e) => {
      e.preventDefault();
      console.log("Avatar image load failed:", {
        user: user?.name,
        email: user?.email,
        imageUrl: currentImage,
      });

      // S3 이미지인 경우 presigned URL 시도
      if (
        currentImage &&
        currentImage.includes("s3.amazonaws.com") &&
        user?.token
      ) {
        await handleS3ImageError(currentImage);
      } else {
        setImageError(true);
      }
    };

    // Vapor UI size mapping
    const getVaporSize = (size) => {
      switch (size) {
        case "sm":
          return "sm";
        case "lg":
          return "lg";
        case "xl":
          return "xl";
        default:
          return "md";
      }
    };

    return (
      <Avatar.Root
        ref={ref}
        size={getVaporSize(size)}
        className={className}
        onClick={onClick}
        src={currentImage && !imageError ? currentImage : undefined}
        style={{
          backgroundColor: avatarStyles.backgroundColor,
          color: avatarStyles.color,
          cursor: onClick ? "pointer" : "default",
          opacity: isLoading ? 0.7 : 1,
          ...props.style,
        }}
        {...props}
      >
        {currentImage && !imageError ? (
          <Avatar.Image
            onError={handleImageError}
            alt={`${user?.name}'s profile`}
          />
        ) : null}
        <Avatar.Fallback
          style={{
            backgroundColor: avatarStyles.backgroundColor,
            color: avatarStyles.color,
            fontWeight: "500",
          }}
        >
          {showInitials ? user?.name?.[0]?.toUpperCase() || "?" : ""}
        </Avatar.Fallback>
      </Avatar.Root>
    );
  }
);

PersistentAvatar.displayName = "PersistentAvatar";

export default PersistentAvatar;
