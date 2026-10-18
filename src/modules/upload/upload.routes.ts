import { Router } from 'express';
import multer from 'multer';
import { UploadController } from './upload.controller';
import { authMiddleware } from '../../common/middleware/auth';

export const uploadRouter = Router();
const controller = new UploadController();

// Multer: lưu ảnh vào memory buffer (không ghi ra disk)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file ảnh (JPG, PNG, WEBP, GIF)'));
    }
  },
});

// Tất cả endpoint upload cần đăng nhập
uploadRouter.use(authMiddleware);

// POST /api/v1/upload/image
uploadRouter.post(
  '/image',
  upload.single('image'),
  (req, res, next) => controller.uploadImage(req, res, next),
);
