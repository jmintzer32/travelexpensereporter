
import { Injectable } from '@angular/core';
import { GoogleGenAI, Type } from '@google/genai';
import { Expense } from '../models/expense.model';

@Injectable({
  providedIn: 'root',
})
export class GeminiService {
  private readonly ai: GoogleGenAI;

  constructor() {
    // Access the API key from the environment variables.
    let apiKey: string | undefined;
    
    // Try global variable first (injected by some build tools)
    try {
      // @ts-ignore
      if (typeof GEMINI_API_KEY !== 'undefined') {
        // @ts-ignore
        apiKey = GEMINI_API_KEY;
      }
    } catch (e) {
      // Ignore
    }

    // Try process.env (injected by other build tools)
    if (!apiKey && typeof process !== 'undefined' && process.env) {
      apiKey = process.env['GEMINI_API_KEY'] || process.env['API_KEY'];
    }

    // Try window object (runtime injection)
    if (!apiKey && typeof window !== 'undefined') {
      apiKey = (window as any).GEMINI_API_KEY;
    }

    // Handle placeholder if not replaced
    if (apiKey === '__GEMINI_API_KEY__') {
      apiKey = undefined;
    }

    if (!apiKey) {
      console.warn("GEMINI_API_KEY environment variable not set. AI features will not work.");
      this.ai = null as any;
    } else {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  async generateExpenseReport(statementContent: string, startDate: string, endDate: string): Promise<Expense[]> {
    if (!this.ai) {
      throw new Error('Gemini API key is not configured. Please set GEMINI_API_KEY.');
    }
    const model = 'gemini-2.5-flash';
        const prompt = `
      You are an expert expense reporting assistant. Your task is to analyze the provided credit card statement content, which could be from a CSV, a plain text file, or text extracted from a PDF.
      
      Instructions:
      1. Extract all financial transactions that occurred between the dates ${startDate} and ${endDate}, inclusive.
      2. CRITICAL: Also include any FLIGHT or TRANSPORTATION expenses that were charged BEFORE ${startDate}, but have a "Departure Date", "Travel Date", or similar date mentioned in the description that falls within the range ${startDate} to ${endDate}.
      3. For each valid transaction, identify its date, merchant name, a detailed transaction description, the merchant's zip code, and the amount.
      4. If a transaction is categorized as 'Meals' or 'Lodging', you MUST find the merchant's zip code, even if it's not present in the statement. You can infer it from the merchant's name and any available location details. For all other categories, provide the zip code only if it's directly available.
      5. If a merchant's zip code cannot be found or reasonably inferred, you MUST return "N/A" for the zipCode field. Do not leave it blank.
      6. Categorize each transaction into one of the following travel expense categories: 'Airfare', 'Lodging', 'Meals', 'Transportation', 'Entertainment', or 'Other'.
      7. The amount should be a positive number, representing an expense. Ignore payments or credits to the account.
      8. Provide the output as a valid JSON array of objects, strictly adhering to the provided schema.
      9. If no transactions are found in the date range, return an empty array.

      Here is the credit card statement data:
      ---
      ${statementContent}
      ---
    `;

    const responseSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            date: {
              type: Type.STRING,
              description: 'The date of the transaction in YYYY-MM-DD format.',
            },
            merchant: {
              type: Type.STRING,
              description: 'The name of the merchant or vendor.',
            },
            description: {
              type: Type.STRING,
              description: 'Additional details about the transaction from the statement.',
            },
            category: {
              type: Type.STRING,
              description: "The expense category (e.g., 'Airfare', 'Lodging', 'Meals', 'Transportation', 'Entertainment', 'Other').",
            },
            amount: {
              type: Type.NUMBER,
              description: 'The transaction amount as a positive number.',
            },
            zipCode: {
                type: Type.STRING,
                description: "The merchant's zip code. Must be provided for 'Meals' and 'Lodging'. Return 'N/A' if not found.",
            },
          },
          required: ["date", "merchant", "description", "category", "amount", "zipCode"],
        },
      };

    try {
      const response = await this.ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: responseSchema,
        },
      });

      const jsonText = response.text.trim();
      const parsedResult = JSON.parse(jsonText) as Expense[];
      
      // Sort expenses by date
      return parsedResult.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    } catch (error) {
      console.error('Error calling Gemini API:', error);
      throw new Error('Failed to process the statement with the AI model.');
    }
  }
}
