-- Step 1: Backfill returnedQuantity from historical return_items
UPDATE order_items oi
LEFT JOIN (
    SELECT
        orderItemId,
        SUM(quantity) AS returned_qty
    FROM return_items
    GROUP BY orderItemId
) r ON r.orderItemId = oi.id
SET oi.returnedQuantity = COALESCE(r.returned_qty, 0);

-- Step 2: Add check constraint to ensure returnedQuantity stays within [0, quantity]
ALTER TABLE order_items
ADD CONSTRAINT chk_order_item_returned_quantity
CHECK (
    returnedQuantity >= 0
    AND returnedQuantity <= quantity
);
