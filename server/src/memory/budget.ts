export interface LifecycleQuote { amount: string; currency: 'WAL'; expiresAt: string; epochs: number }
export function validateBudget(quote: LifecycleQuote, ceiling: string) {
  if (!/^\d+$/.test(quote.amount) || !/^\d+$/.test(ceiling) || BigInt(quote.amount) > BigInt(ceiling) || !Number.isSafeInteger(quote.epochs) || quote.epochs < 1 || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('LIFECYCLE_BUDGET_OR_QUOTE_INVALID');
}
