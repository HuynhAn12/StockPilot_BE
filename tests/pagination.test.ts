import {
  productListQuerySchema,
  orderListQuerySchema,
  movementListQuerySchema,
  idParamSchema,
  sanitizeSortField,
} from '../src/common/utils/pagination';

describe('Pagination & Whitelisting Utilities', () => {
  describe('idParamSchema', () => {
    it('Accepts positive integers', () => {
      const parsed = idParamSchema.parse({ id: '123' });
      expect(parsed.id).toBe(123);
    });

    it('Rejects negative numbers and zero', () => {
      expect(() => idParamSchema.parse({ id: '0' })).toThrow();
      expect(() => idParamSchema.parse({ id: '-5' })).toThrow();
      expect(() => idParamSchema.parse({ id: 'abc' })).toThrow();
    });
  });

  describe('productListQuerySchema', () => {
    it('Parses search keyword q, categoryId, and boolean isActive', () => {
      const result = productListQuerySchema.parse({
        q: 'Nike Air',
        categoryId: '5',
        isActive: 'true',
        page: '2',
        limit: '50',
      });

      expect(result.q).toBe('Nike Air');
      expect(result.categoryId).toBe(5);
      expect(result.isActive).toBe(true);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(50);
    });
  });

  describe('orderListQuerySchema', () => {
    it('Preserves status filter enum', () => {
      const result = orderListQuerySchema.parse({
        status: 'FULFILLED',
        page: '1',
      });
      expect(result.status).toBe('FULFILLED');
    });

    it('Rejects invalid status', () => {
      expect(() => orderListQuerySchema.parse({ status: 'UNKNOWN' })).toThrow();
    });
  });

  describe('movementListQuerySchema', () => {
    it('Preserves stockItemId and movement type', () => {
      const result = movementListQuerySchema.parse({
        stockItemId: '42',
        type: 'RETURN_RESTOCK',
      });
      expect(result.stockItemId).toBe(42);
      expect(result.type).toBe('RETURN_RESTOCK');
    });
  });

  describe('sanitizeSortField', () => {
    const allowed = ['createdAt', 'name', 'totalAmount'];

    it('Returns valid allowed field', () => {
      expect(sanitizeSortField('name', allowed)).toBe('name');
      expect(sanitizeSortField('totalAmount', allowed)).toBe('totalAmount');
    });

    it('Falls back to default if field is not whitelisted or SQL injection attempt', () => {
      expect(sanitizeSortField('nonExistentField', allowed, 'createdAt')).toBe('createdAt');
      expect(sanitizeSortField('name; DROP TABLE users;', allowed, 'createdAt')).toBe('createdAt');
      expect(sanitizeSortField(undefined, allowed, 'createdAt')).toBe('createdAt');
    });
  });
});
