import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';

// Reads ANTHROPIC_API_KEY from the environment (a Secret Manager secret on
// Cloud Run). Created on first use so the server starts even without it.
let client;

export class StatementError extends Error {}

// What each category covers, so lines land in the right Coupa category.
// Categories the app adds later still work, just without a note.
const CATEGORY_NOTES = {
  Airfare: 'plane tickets, with any agency booking fee folded in',
  Lodging: 'hotels and other stays',
  Meals: 'restaurants, coffee and other food while traveling',
  'Rental Car': 'car rental charges',
  Fuel: 'gas for a rental or own car',
  'Taxi & Ride Share': 'Uber, Lyft, taxis, trains and public transit',
  'Parking & Tolls': 'garages, parking apps and tolls',
  'Travel Fees': 'airline seat, bag, upgrade and early-boarding fees',
  Supplies: 'hardware, office and jobsite supply purchases',
  Other: 'travel expenses that fit nowhere else',
};

function prompt({ startDate, endDate, categories }) {
  const categoryList = categories
    .map(c => (CATEGORY_NOTES[c] ? `- ${c}: ${CATEGORY_NOTES[c]}` : `- ${c}`))
    .join('\n');
  return `You're helping an employee of a construction company turn their corporate card statement into an expense report in Coupa, the company's expense system. They travel to project sites and file one Coupa report per trip. Every line you return becomes a line on that report: their approver reviews it, and Coupa checks it before the report can be submitted.

This request covers one trip, from ${startDate} to ${endDate}. The statement may also hold charges from other trips or from home, which are handled separately, so return only the expenses that belong to this trip. Most are charged during the trip itself.

Travel booked ahead is the exception to watch for. Flights, and sometimes trains, are often paid for days or weeks before the trip, so their charge date falls before ${startDate}, possibly on an earlier month's statement. Include such a charge when it is for this trip: its description shows a travel date within the trip, or a route or destination that matches the trip's travel. Date that line by the travel date, so it sorts with the rest of the trip. A ticket bought ahead for a different trip, with travel dates outside this one, stays out. Hotels are never paid ahead: they're charged during or at the end of the stay, so a hotel charge from before the trip belongs to a different one.

Payments, credits and refunds aren't expenses. Leave out charges that clearly have nothing to do with the trip, like streaming or other personal subscriptions. The employee reviews the list before it goes into Coupa, so when a charge plausibly belongs to the trip, include it.

Give one line per expense as the approver would think of it. When one expense was billed as more than one charge, combine them into a single line with the total. The usual case is a travel agency's booking or service fee (Egencia, Concur, Navan and the like) charged alongside the ticket: it belongs on that flight's Airfare line, with "incl. booking fee" added to the description. Genuinely separate expenses stay separate, such as two flights, two hotel stays, or an airline's seat or bag fee.

For each line:
- date: the day it was charged, as YYYY-MM-DD, or the travel date for travel booked ahead.
- merchant: the business name without card-processor noise ("UBER *TRIP" becomes "Uber").
- description: what the expense was, in plain words (see below).
- category: the one from the list below that fits best.
- amount: the amount in dollars, as a positive number.
- zipCode: as described below.

Descriptions are what the approver reads, so write each one the way the employee would describe the expense to them: what it was and where, never the card's merchant text ("EGENCIA FEE", "UBER *TRIP"). Work out the trip's destination from the flights, hotel and the cities on the statement, and the employee's home from where the flights start and end. Some examples of the style:
- Flights: "Flight to SFO" for the way out, "Flight home from SFO" for the way back, "Round trip SFO-IAD" when one ticket covers both.
- Meals: name the meal when it's clear from the merchant or a time on the statement ("Dinner in Washington DC", "Breakfast in Seattle"), otherwise "Meal in San Francisco".
- Getting around: "Rental car in Seattle", "Rental car fuel", "Uber to airport", "Uber in San Francisco", "Parking at SFO".
- Hotels: "Hotel in Washington DC, 3 nights" when the nights are known.
Keep them short, a few words each.

Categories:
${categoryList}

Zip codes: Coupa won't accept the report unless every Meals and Lodging line has a 5-digit US zip code, so those lines always need one. Use the zip printed on the statement when there is one. When there isn't, work out where the merchant is from its name, any store number, and the city and state on the statement line, and give that location's zip. When only the city is known, give that city's main zip code; an approximate zip lets the report go through, a missing one blocks it. For other categories, give the zip only when the statement shows it, and "N/A" otherwise. Use 5 digits, without the +4.`;
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
            zipCode: { type: 'string', description: '5-digit US zip code; always given for Meals and Lodging, "N/A" allowed only for other categories' },
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
    messages: [{ role: 'user', content: `Card statement:\n\n${statement}` }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new StatementError('Claude declined to process this statement.');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new StatementError('The statement produced more expenses than fit in one response. Try a shorter date range.');
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const expenses = JSON.parse(text).expenses.map(e => ({ ...e, zipCode: cleanZip(e.zipCode) }));
  try {
    await fillMissingZips(expenses, statement);
  } catch (error) {
    // The app still asks for any zip that's missing.
    console.error('Zip code follow-up failed:', error);
  }
  return expenses;
}

// Categories Coupa won't accept without a zip code.
const ZIP_REQUIRED = ['Meals', 'Lodging'];

function cleanZip(zip) {
  const match = /\b(\d{5})(?:-\d{4})?\b/.exec(String(zip ?? ''));
  return match ? match[1] : 'N/A';
}

// A focused second question for any meal or lodging line that still has no
// zip code. Lines it can't place keep "N/A" and the app asks for them.
async function fillMissingZips(expenses, statement) {
  const missing = expenses
    .map((e, index) => ({ ...e, index }))
    .filter(e => ZIP_REQUIRED.includes(e.category) && e.zipCode === 'N/A');
  if (!missing.length) return;

  const list = missing.map(e => `${e.index}. ${e.date} | ${e.merchant} | ${e.description} | $${e.amount}`).join('\n');
  const message = await client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'high',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            zips: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  zipCode: { type: 'string', description: '5-digit US zip code' },
                },
                required: ['index', 'zipCode'],
                additionalProperties: false,
              },
            },
          },
          required: ['zips'],
          additionalProperties: false,
        },
      },
    },
    system: 'These meal and lodging lines from a corporate travel expense report have no zip code, and Coupa won\'t accept the report until each one has a 5-digit US zip code. ' +
      'For each line, give the zip code of the place the charge was made. Use the merchant name, store number, city and state on the line, and the rest of the statement for context: ' +
      'the traveler was in the same area as their hotel, rental car and taxi charges from around those dates. ' +
      'When only the city is known, give that city\'s main zip code; an approximate zip lets the report go through, a missing one blocks it. Give a zip for every index listed.',
    messages: [{ role: 'user', content: `Lines missing a zip code (index. date | merchant | description | amount):\n${list}\n\nThe full card statement, for context:\n${statement}` }],
  }).finalMessage();
  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') return;

  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  for (const { index, zipCode } of JSON.parse(text).zips ?? []) {
    if (expenses[index] && expenses[index].zipCode === 'N/A') expenses[index].zipCode = cleanZip(zipCode);
  }
}
