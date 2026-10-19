import { Expense } from '../models/expense.model';

// Travel agency booking/service fees that appear as their own small charge
// next to the ticket (e.g. Egencia's per-trip fee).
const AGENCY_FEE = /egencia|concur|navan|tripactions|amex\s*gbt|bcd\s*travel|\bcwt\b|booking\s*fee|service\s*fee|agent\s*fee/i;
// Agency fees are small; a larger agency charge is the ticket itself.
const MAX_FEE = 50;
// How far apart (in days) a fee and its flight can be charged.
const MAX_DAYS = 3;

// Folds each agency booking fee into the flight it belongs to, so Coupa gets
// one Airfare line with the full cost. A fee with no flight nearby is kept.
export function mergeBookingFees(expenses: Expense[]): Expense[] {
  const isFee = (e: Expense) => e.amount <= MAX_FEE && AGENCY_FEE.test(`${e.merchant} ${e.description}`);
  const result = expenses.map(e => ({ ...e }));
  const flights = result.filter(e => e.category === 'Airfare' && !isFee(e));

  return result.filter(fee => {
    if (!isFee(fee)) return true;
    const flight = closest(flights, fee);
    if (!flight) return true;
    flight.amount = Math.round((flight.amount + fee.amount) * 100) / 100;
    flight.description = `${flight.description} (incl. $${fee.amount.toFixed(2)} booking fee)`;
    return false;
  });
}

function closest(flights: Expense[], fee: Expense): Expense | undefined {
  let best: Expense | undefined;
  let bestDays = Infinity;
  for (const flight of flights) {
    const days = Math.abs(dayNumber(flight.date) - dayNumber(fee.date));
    if (days <= MAX_DAYS && days < bestDays) {
      best = flight;
      bestDays = days;
    }
  }
  return best;
}

function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(isoDate.slice(0, 10)) / 86_400_000);
}
