import { Injectable } from '@angular/core';
import { Expense } from '../models/expense.model';
import { EXPENSE_CATEGORIES } from '../models/expense-categories';
import { mergeBookingFees } from './merge-fees';

const PASSCODE_KEY = 'expenseAi.passcode';

// Reads a trip's expenses out of statement text with Claude, through this
// site's server (server/index.js), which holds the API key.
@Injectable({ providedIn: 'root' })
export class ExpenseAiService {
  async generateExpenseReport(statementContent: string, startDate: string, endDate: string): Promise<Expense[]> {
    const body = JSON.stringify({ statement: statementContent, startDate, endDate, categories: EXPENSE_CATEGORIES });
    let res = await this.post(body);
    if (res.status === 401) {
      // The server has APP_PASSCODE set: ask once, then remember it here.
      const entered = window.prompt('Enter the passcode for this expense site:');
      if (!entered) throw new Error('A passcode is required to analyze statements.');
      this.savePasscode(entered.trim());
      res = await this.post(body);
      if (res.status === 401) {
        this.savePasscode('');
        throw new Error('That passcode isn’t right.');
      }
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `The server couldn’t analyze the statement (HTTP ${res.status}).`);
    }
    const expenses = mergeBookingFees(data.expenses as Expense[]);
    return expenses.sort((a, b) => a.date.localeCompare(b.date));
  }

  private post(body: string): Promise<Response> {
    return fetch('api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-passcode': this.passcode() },
      body,
    });
  }

  private passcode(): string {
    try {
      return localStorage.getItem(PASSCODE_KEY) || '';
    } catch {
      return '';
    }
  }

  private savePasscode(value: string): void {
    try {
      localStorage.setItem(PASSCODE_KEY, value);
    } catch {
      // Asked again next time.
    }
  }
}
