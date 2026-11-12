/**
 * Single source of truth for what a store owes on a delivery, used by both the
 * invoice PDF and the Stripe charge so they always match.
 */
export const GST_RATE = 0.05;

const cents = value => Math.round(value * 100) / 100;

export function billingTotals(data = {}) {
  const price = cents(Number(data.price) || 0);
  const credits = cents((data.credits || []).reduce((sum, credit) => sum + (Number(credit.amount) || 0), 0));
  const subtotal = cents(Math.max(0, price - credits));
  const tax = cents(subtotal * GST_RATE);
  return { price, credits, subtotal, tax, total: cents(subtotal + tax) };
}

/** Amount to refund (credit plus its GST) when a credit is granted after payment. */
export function creditRefundAmount(creditAmount) {
  return cents(creditAmount + creditAmount * GST_RATE);
}
