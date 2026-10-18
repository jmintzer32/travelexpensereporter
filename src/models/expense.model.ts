
export interface Expense {
  date: string;
  merchant: string;
  description: string;
  category: string;
  amount: number;
  zipCode: string;
  // Project to charge this line to, when not the trip's (CoupaProject.id).
  projectId?: string;
}
