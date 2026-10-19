import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';

// Reads ANTHROPIC_API_KEY from the environment (a Secret Manager secret on
// Cloud Run). Created on first use so the server starts even without it.
let client;

export class StatementError extends Error {}

function prompt({ startDate, endDate, categories }) {
  return `You are preparing a corporate travel expense report from credit card statement data. The statement may be a CSV, a spreadsheet export, plain text, or text extracted from a PDF.

Return every expense for the trip from ${startDate} to ${endDate}, inclusive:

1. Include each charge dated within the trip. Also include flights and other transportation charged before ${startDate} whose travel date (departure date, travel date, or similar in the description) falls within the trip.
2. Leave out payments, credits, refunds, and charges that are clearly personal or unrelated to travel.
3. For each expense give the date (YYYY-MM-DD, the charge date unless rule 1 says otherwise), the merchant, a short description a reviewer would understand (e.g. "Flight SFO-ORD", "Hotel, 3 nights", "Dinner"), the category, the amount as a positive number, and the merchant's zip code.
4. Category: exactly one of ${categories.map(c => `"${c}"`).join(', ')}. Use "Fuel" for gas stations, "Taxi & Ride Share" for Uber, Lyft, taxis and public transit, "Parking & Tolls" for garages, parking apps and tolls, "Travel Fees" for airline baggage, seat, upgrade and early-boarding fees, and "Supplies" for hardware, office and jobsite supply stores.
5. Combine charges that are one expense into a single line with the summed amount: a travel agency booking or service fee (Egencia, Concur, Navan and similar) goes into the flight it was charged with, as one "Airfare" line whose description notes the fee. Keep separate trips, separate flights and separate hotel stays on their own lines.
6. Zip code: required for "Meals" and "Lodging" - use the statement, or infer it from the merchant name and location details. For other categories give it only when the statement shows it. When it can't be found or reasonably inferred, use "N/A".
7. If nothing falls within the trip, return an empty list.`;
}

function schema(categories) {
  return {
    type: 'object',
    properties: {
      expenses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD' },
            merchant: { type: 'string' },
            description: { type: 'string' },
            category: { type: 'string', enum: categories },
            amount: { type: 'number', description: 'Positive amount in the statement currency' },
            zipCode: { type: 'string', description: 'Merchant zip code, or "N/A"' },
          },
          required: ['date', 'merchant', 'description', 'category', 'amount', 'zipCode'],
          additionalProperties: false,
        },
      },
    },
    required: ['expenses'],
    additionalProperties: false,
  };
}

// Returns the trip's expenses read from the statement text.
export async function extractExpenses({ statement, startDate, endDate, categories }) {
  // Streamed: statements can be long, and so can the list of expenses.
  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    // If a safety classifier declines, Anthropic re-runs the request on its
    // recommended fallback model instead of failing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: schema(categories) },
    },
    system: prompt({ startDate, endDate, categories }),
    messages: [{ role: 'user', content: `Statement data:\n\n${statement}` }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new StatementError('Claude declined to process this statement.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new StatementError('The statement produced more expenses than fit in one response. Try a shorter date range.');
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text).expenses;
}
