-- 1. Fix Historical refundableAmount with Pro-Rata allocation based on subtotal weight against Order.totalAmount
UPDATE `order_items` oi
JOIN `orders` o ON oi.`orderId` = o.`id`
SET oi.`refundableAmount` = CASE 
    WHEN o.`subtotalAmount` > 0 THEN ROUND((oi.`subtotal` / o.`subtotalAmount`) * o.`totalAmount`, 2)
    ELSE 0.00
END;

-- 2. Absorb rounding remainder into the highest ID order item per order so SUM(refundableAmount) == Order.totalAmount exactly
UPDATE `order_items` oi
JOIN (
    SELECT 
        oi_inner.`orderId`,
        MAX(oi_inner.`id`) AS max_item_id,
        o.`totalAmount` - SUM(oi_inner.`refundableAmount`) AS remainder
    FROM `order_items` oi_inner
    JOIN `orders` o ON oi_inner.`orderId` = o.`id`
    GROUP BY oi_inner.`orderId`, o.`totalAmount`
    HAVING remainder <> 0.00
) diff ON oi.`id` = diff.max_item_id
SET oi.`refundableAmount` = oi.`refundableAmount` + diff.remainder;

-- 3. Re-calculate historical refundedAmount from return items
UPDATE `order_items` oi
LEFT JOIN (
    SELECT `orderItemId`, SUM(`refundPrice`) AS total_refunded
    FROM `return_items`
    GROUP BY `orderItemId`
) r ON r.`orderItemId` = oi.`id`
SET oi.`refundedAmount` = COALESCE(r.total_refunded, 0.00);

-- 4. Add MySQL CHECK constraints for refundableAmount, refundedAmount, and refund cap
ALTER TABLE `order_items`
ADD CONSTRAINT `chk_order_item_refundable_non_negative`
CHECK (`refundableAmount` >= 0);

ALTER TABLE `order_items`
ADD CONSTRAINT `chk_order_item_refunded_non_negative`
CHECK (`refundedAmount` >= 0);

ALTER TABLE `order_items`
ADD CONSTRAINT `chk_order_item_refund_cap`
CHECK (`refundedAmount` <= `refundableAmount`);
