
import { Expense } from './expense.model';

export interface TripReport {
  trip: {
    // Id of the Trip this report was generated from.
    id?: number;
    startDate: string;
    endDate: string;
  };
  expenses: Expense[];
  total: number;
}
