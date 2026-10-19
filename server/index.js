import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { StatementError, extractExpenses } from './expenses.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The built Angular app (Dockerfile copies it here).
const staticDir = process.env.STATIC_DIR || path.join(here, '../dist');
// Optional: when set, the app asks for this passcode before using Claude,
// so strangers who find the site can't run up the API bill.
const passcode = process.env.APP_PASSCODE || '';

const app = express();
app.use(express.json({ limit: '25mb' }));

app.post('/api/expenses', async (req, res) => {
  if (passcode && req.get('x-app-passcode') !== passcode) {
    res.status(401).json({ error: 'Passcode required.' });
    return;
  }
  const { statement, startDate, endDate, categories } = req.body ?? {};
  if (typeof statement !== 'string' || !statement.trim() || !startDate || !endDate || !Array.isArray(categories) || !categories.length) {
    res.status(400).json({ error: 'Send statement, startDate, endDate and categories.' });
    return;
  }
  try {
    const expenses = await extractExpenses({ statement, startDate, endDate, categories: categories.map(String) });
    res.json({ expenses });
  } catch (error) {
    console.error('Expense extraction failed:', error);
    if (error instanceof StatementError) {
      res.status(422).json({ error: error.message });
    } else if (error instanceof Anthropic.AuthenticationError) {
      res.status(500).json({ error: 'The server’s Claude API key is missing or invalid (ANTHROPIC_API_KEY).' });
    } else if (error instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: 'Claude is rate limited right now. Try again in a minute.' });
    } else if (error instanceof Anthropic.APIError) {
      res.status(502).json({ error: `Claude API error ${error.status}: ${error.message}` });
    } else if (error instanceof SyntaxError) {
      res.status(502).json({ error: 'Claude’s answer wasn’t valid JSON. Try again.' });
    } else {
      res.status(500).json({ error: String(error?.message || error) });
    }
  }
});

app.use(express.static(staticDir, {
  setHeaders(res, file) {
    // The bookmarklet source and the page itself must never be stale.
    if (file.endsWith('index.html') || file.includes(`${path.sep}public${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/-[A-Z0-9]{8,}\.(js|css)$/i.test(file)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
// Single-page app: every other path gets the app.
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(staticDir, 'index.html'));
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set; statement analysis will fail.');
  console.log(`Listening on ${port}`);
});
