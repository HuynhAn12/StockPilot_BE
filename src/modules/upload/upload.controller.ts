import { Request, Response, NextFunction } from 'express';
import { uploadImageBuffer } from './upload.service';

export class UploadController {
  /**
   * POST /api/v1/upload/image
   * Nhận file ảnh từ multipart/form-data, upload lên Cloudinary, trả về URL
   */
  async uploadImage(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'Vui lòng chọn file ảnh để upload' },
        });
      }

      // Kiểm tra MIME type
      const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
      if (!allowedMimes.includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_FILE_TYPE',
            message: 'Chỉ chấp nhận ảnh định dạng JPG, PNG, WEBP, GIF',
          },
        });
      }

      // Giới hạn 10MB
      if (req.file.size > 10 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          error: { code: 'FILE_TOO_LARGE', message: 'Ảnh không được lớn hơn 10MB' },
        });
      }

      const result = await uploadImageBuffer(req.file.buffer, 'stockpilot');

      return res.status(200).json({
        success: true,
        message: 'Upload ảnh thành công',
        data: {
          url: result.secureUrl,
          publicId: result.publicId,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}
