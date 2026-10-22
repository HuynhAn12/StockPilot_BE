import { PosPayosService } from '../src/modules/pos/pos-payos.service';

// Unit-level: does not depend on auto-increment store ids, so CI (fresh DB, small ids)
// and local runs (large ids) behave the same.
describe('PayOS orderCode generation', () => {
  const freeDb = () => ({ payment: { findUnique: jest.fn().mockResolvedValue(null) } }) as any;

  it.each([1, 7, 42, 999, 1000, 12345])('keeps 15 digits and the store partition for storeId %i', async (storeId) => {
    const code = await new PosPayosService(freeDb()).generateUniqueOrderCode(storeId);
    const digits = String(code);

    expect(Number.isSafeInteger(code)).toBe(true);
    expect(digits).toHaveLength(15);
    expect(digits.slice(0, 5)).toBe(`1${String(storeId % 10000).padStart(4, '0')}`);
  });

  it('falls back to a 15-digit "2"-prefixed code when every attempt collides', async () => {
    const db = { payment: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) } } as any;

    const code = await new PosPayosService(db).generateUniqueOrderCode(1);

    expect(db.payment.findUnique).toHaveBeenCalledTimes(10);
    expect(String(code)).toHaveLength(15);
    expect(String(code).startsWith('2')).toBe(true);
    expect(Number.isSafeInteger(code)).toBe(true);
  });
});
