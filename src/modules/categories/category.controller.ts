import { Request, Response, NextFunction } from 'express';
import { CategoryService } from './category.service';

const categoryService = new CategoryService();

export class CategoryController {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const categories = await categoryService.listCategories(storeId);
      return res.status(200).json({ success: true, data: categories });
    } catch (error) {
      next(error);
    }
  }

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const category = await categoryService.getCategoryById(storeId, id);
      return res.status(200).json({ success: true, data: category });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const category = await categoryService.createCategory(storeId, req.body);
      return res.status(201).json({ success: true, message: 'Tạo danh mục thành công', data: category });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      const category = await categoryService.updateCategory(storeId, id, req.body);
      return res.status(200).json({ success: true, message: 'Cập nhật danh mục thành công', data: category });
    } catch (error) {
      next(error);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction) {
    try {
      const storeId = req.user!.storeId!;
      const id = Number(req.params.id);
      await categoryService.deleteCategory(storeId, id);
      return res.status(200).json({ success: true, message: 'Xóa danh mục thành công' });
    } catch (error) {
      next(error);
    }
  }
}
