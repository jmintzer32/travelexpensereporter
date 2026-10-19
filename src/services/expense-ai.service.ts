import { Injectable } from '@angular/core';
import { Expense } from '../models/expense.model';
import { EXPENSE_CATEGORIES } from '../models/expense-categories';
import { mergeBookingFees } from './merge-fees';

// Reads a trip's expenses out of statement text with Claude, through this
// site's server (server/index.js), which holds the API key.
@Injectable({ providedIn: 'root' })
export class ExpenseAiService {
  async generateExpenseReport(statementContent: string, startDate: string, endDate: string): Promise<Expense[]> {
    const res = await fetch('api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: statementContent, startDate, endDate, categories: EXPENSE_CATEGORIES }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `The server couldn’t analyze the statement (HTTP ${res.status}).`);
    }
    const expenses = mergeBookingFees(data.expenses as Expense[]);
    return expenses.sort((a, b) => a.date.localeCompare(b.date));
  }
}
