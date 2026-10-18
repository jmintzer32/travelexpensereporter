# Travel Expense Reporter

This is an Angular application for extracting and categorizing travel expenses from credit card statements using Google Gemini AI.

## Prerequisites

- Node.js (v18 or later)
- Docker (optional, for containerized deployment)
- Google Cloud SDK (gcloud) (for deployment to Cloud Run)

## Local Development

1.  Install dependencies:
    ```bash
    npm install
    ```

2.  Start the development server:
    ```bash
    npm start
    ```
    Navigate to `http://localhost:4200/`.

## Deployment to Google Cloud Run

This application is containerized using Docker and can be deployed to Google Cloud Run.

### 1. Build the Docker Image

```bash
docker build -t travel-expense-reporter .
```

### 2. Run Locally (Optional)

To test the container locally, you need to provide your Gemini API key:

```bash
docker run -p 8080:8080 -e GEMINI_API_KEY=your_api_key_here travel-expense-reporter
```
Navigate to `http://localhost:8080/`.

### 3. Push to Google Container Registry (GCR) or Artifact Registry

First, configure Docker to authenticate with gcloud:
```bash
gcloud auth configure-docker
```

Tag and push the image:
```bash
# Replace PROJECT_ID with your Google Cloud Project ID
docker tag travel-expense-reporter gcr.io/PROJECT_ID/travel-expense-reporter
docker push gcr.io/PROJECT_ID/travel-expense-reporter
```

### 4. Deploy to Cloud Run

Deploy the image to Cloud Run, setting the `GEMINI_API_KEY` environment variable:

```bash
gcloud run deploy travel-expense-reporter \
  --image gcr.io/PROJECT_ID/travel-expense-reporter \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=your_api_key_here
```

Replace `your_api_key_here` with your actual Gemini API key.

## GitHub Integration

To push this code to GitHub:

1.  Initialize a Git repository:
    ```bash
    git init
    ```

2.  Add files:
    ```bash
    git add .
    ```

3.  Commit changes:
    ```bash
    git commit -m "Initial commit"
    ```

4.  Add remote repository:
    ```bash
    git remote add origin https://github.com/your-username/your-repo-name.git
    ```

5.  Push to GitHub:
    ```bash
    git push -u origin main
    ```

## Configuration

-   **GEMINI_API_KEY**: Required environment variable for the AI features to work. Get your key from [Google AI Studio](https://aistudio.google.com/).

## Entering expenses into Coupa

The site has a step-by-step guide: click **How it works** at the top of the page.

After generating reports, the **4. Enter into Coupa** panel offers three ways to get lines into Coupa. Give each trip a **Business Purpose** in step 2, since Coupa requires one on every line. The settings button (sliders icon) sets the date format, currency, the Coupa Expense Category for each app category (preset to Coupa's names, e.g. Meals → Meals - Travel), and your projects. When Coupa doesn't list a category or zip code, the filler fills the rest of the line and leaves that field for you.

- **Entry mode**: click-to-copy each field in Coupa's order. `Enter` copies the next field, `1`–`9` copy a specific one, `↑`/`↓` change line. Nothing to install.
- **Bookmarklet**: drag the "Coupa Filler" button to your bookmarks bar, click **Copy for bookmarklet**, then click the bookmark in Coupa and paste. Each trip becomes its own Coupa report: pick the trip in the panel, click **New Coupa report for this trip**, then **Fill next** (or **Fill all** with auto-save on). It's preset for Coupa's expense screen; if Coupa changes, the panel's **Setup** tab has a **Pick** button to point at a button or field again, and **Copy setup** / **Import setup** move that setup between computers.
- **Project cost codes**: add projects (company code, project number, name, usual WBS element) from a trip's **Project** list, or paste past cost codes like `4010-Project WBS-12345B1-01A.021200` into **Add projects from cost codes** in the settings. Pick a project per trip; any expense line can be switched to a different project in the results table. In the Coupa Filler panel (on your Coupa page, **Setup** tab), click **Teach** once and pick a cost code in Coupa's Account search as usual; the filler records which choices were the company code, project and WBS element, and from then on sets the cost code on every line, for any project. **Copy setup** includes what it learned.
- **Chrome extension** (`coupa-extension/`, load unpacked at `chrome://extensions`): same filler, without copy and paste. It runs only on this app's URL and on whatever tab you open it in.

The bookmarklet and the extension share one script, `public/coupa-filler.js`. `npm run build` copies it into `coupa-extension/` (via `scripts/sync-extension.mjs`), so edit only the copy in `public/`.
