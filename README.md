# Travel Expense Reporter

Reads credit card statements, pulls out each trip's travel expenses with Claude, and helps enter them into Coupa.

The Angular app (`src/`) runs in the browser. A small Node server (`server/`) serves it and does the statement analysis with Claude, so the Claude API key stays on the server and never reaches the browser.

## Prerequisites

- Node.js 20 or later
- A Claude API key from [console.anthropic.com](https://console.anthropic.com/) (Settings → API keys)
- Google Cloud SDK (`gcloud`), to deploy to Cloud Run

## Local development

```bash
npm install
(cd server && npm install)
npm run build
cd server && ANTHROPIC_API_KEY=sk-ant-... node index.js
```

Then open `http://localhost:8080/`. (`npm run dev` serves the app alone, without the server, so statement analysis won't work there.)

## Configuration (environment variables on the server)

- **ANTHROPIC_API_KEY** (required): the Claude API key. On Cloud Run, store it in Secret Manager (below).

The site is public, so anyone with the link can run statements through your Claude account. Set a monthly spend limit in the Claude Console (**Settings → Limits**) to cap the cost.

## Deploying to Google Cloud Run

### 1. Give the Claude API key to the service

Console: **Cloud Run → your service → Edit & deploy new revision → Variables & Secrets → Add variable**: name `ANTHROPIC_API_KEY`, value your key. Remove the old `GEMINI_API_KEY` variable. Or:

```bash
gcloud run services update SERVICE_NAME --region us-central1 \
  --update-env-vars ANTHROPIC_API_KEY=sk-ant-... \
  --remove-env-vars GEMINI_API_KEY
```

The key stays on the server (visitors never see it), but people with access to the Google Cloud project can read it in the service's settings. If you can use Secret Manager, reference a secret instead (**Reference a secret** on the same screen; the service account needs **Secret Manager Secret Accessor** on it).

These settings stay with the service, so later deploys from GitHub keep them.

### 2. Deploy

If the service redeploys from GitHub automatically, pushing to `main` is enough. Otherwise:

```bash
gcloud run deploy SERVICE_NAME --source . --region us-central1 --allow-unauthenticated
```

To try the container locally: `docker build -t travel-expense-reporter .` then `docker run -p 8080:8080 -e ANTHROPIC_API_KEY=sk-ant-... travel-expense-reporter`.

## Entering expenses into Coupa

The site has a step-by-step guide: click **How it works** at the top of the page.

After generating reports, the **4. Enter into Coupa** panel offers three ways to get lines into Coupa. Give each trip a **Business Purpose** in step 2, since Coupa requires one on every line. The settings button (sliders icon) sets the date format, currency, the Coupa Expense Category for each app category (preset to Coupa's names, e.g. Meals → Meals - Travel), and your projects. When Coupa doesn't list a category or zip code, the filler fills the rest of the line and leaves that field for you.

- **Entry mode**: click-to-copy each field in Coupa's order. `Enter` copies the next field, `1`–`9` copy a specific one, `↑`/`↓` change line. Nothing to install.
- **Bookmarklet**: drag the "Coupa Filler" button to your bookmarks bar, click **Copy for bookmarklet**, then click the bookmark in Coupa and paste. Each trip becomes its own Coupa report: pick the trip in the panel, click **New Coupa report for this trip**, then **Fill next** or **Fill all**; each line is saved in Coupa as it's filled. It's preset for Coupa's expense screen; if Coupa changes, the panel's **Setup → Advanced** section has a **Pick** button to point at a button or field again, and **Copy setup** / **Import setup** move that setup between computers.
- **Project cost codes**: add projects (company code, project number, name, usual WBS element) from a trip's **Project** list, or paste past cost codes like `4010-Project WBS-12345B1-01A.021200` into **Add projects from cost codes** in the settings. Pick a project per trip; any expense line can be switched to a different project in the results table. The Coupa Filler sets each line's cost code by typing the project's codes (company, Project WBS, project number, WBS element) into the search box of each field in Coupa's Account search and picking the one match. If that doesn't work, **Teach** (panel's **Cost codes** tab) records how you pick one, as a fallback. A cost code that can't be set never holds up a line: the line is saved anyway and listed on the Cost codes tab with the code to set in Coupa. To add a project you only have in Coupa, use **Add a project** on the panel's Cost codes tab, then **Add to expense site**: this site opens with the project added (Coupa and this site can't read each other's saved data, so the panel hands it over in the link). **Copy setup** includes what it learned.
- **Booking fees**: a travel agency booking fee (Egencia and similar, up to $50) charged within 3 days of a flight is folded into that flight's Airfare line (`src/services/merge-fees.ts`).
- **Chrome extension** (`coupa-extension/`, load unpacked at `chrome://extensions`): same filler, without copy and paste. It runs only on this app's URL and on whatever tab you open it in.

The bookmarklet and the extension share one script, `public/coupa-filler.js`. `npm run build` copies it into `coupa-extension/` (via `scripts/sync-extension.mjs`), so edit only the copy in `public/`.
