
import { Expense } from './expense.model';

export interface TripReport {
  trip: {
    startDate: string;
    endDate: string;
  };
  expenses: Expense[];
  total: number;
}
