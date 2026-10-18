import { v2 as cloudinary } from 'cloudinary';

// Cấu hình Cloudinary từ env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

/**
 * Upload một buffer ảnh lên Cloudinary
 * @param buffer - File buffer từ multer
 * @param folder - Thư mục đích trên Cloudinary
 * @returns UploadResult với URL và metadata ảnh
 */
export async function uploadImageBuffer(
  buffer: Buffer,
  folder = 'stockpilot',
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        // Tự động tối ưu format (webp/avif) và chất lượng
        transformation: [
          { quality: 'auto', fetch_format: 'auto', width: 800, crop: 'limit' },
        ],
      },
      (error, result) => {
        if (error) {
          reject(new Error(`Cloudinary upload failed: ${error.message}`));
          return;
        }
        if (!result) {
          reject(new Error('Cloudinary upload returned no result'));
          return;
        }
        resolve({
          url: result.url,
          secureUrl: result.secure_url,
          publicId: result.public_id,
          width: result.width,
          height: result.height,
          format: result.format,
          bytes: result.bytes,
        });
      },
    );

    uploadStream.end(buffer);
  });
}

/**
 * Xóa ảnh khỏi Cloudinary theo publicId
 */
export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}
