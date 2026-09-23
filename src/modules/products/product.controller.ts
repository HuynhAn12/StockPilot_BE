import { Request, Response, NextFunction } from 'express';
import { ProductService } from './product.service';
import { maskSensitiveFields } from '../../common/middleware/sensitive-fields';

const productService = new ProductService();

export class ProductController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const products = await productService.listProducts(storeId);
      const masked = maskSensitiveFields(products, req.user?.role);
      return res.status(200).json({ success: true, data: masked });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const product = await productService.getProductById(storeId, id);
      const masked = maskSensitiveFields(product, req.user?.role);
      return res.status(200).json({ success: true, data: masked });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const product = await productService.createProduct(storeId, req.body);
      const masked = maskSensitiveFields(product, req.user?.role);
      return res.status(201).json({ success: true, message: 'Tạo sản phẩm thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const product = await productService.updateProduct(storeId, id, req.body);
      const masked = maskSensitiveFields(product, req.user?.role);
      return res.status(200).json({ success: true, message: 'Cập nhật sản phẩm thành công', data: masked });
    } catch (error) {
      next(error);
    }
  }
}
