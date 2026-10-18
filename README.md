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

After generating reports, the **4. Enter into Coupa** panel offers three ways to get lines into Coupa. The settings button (sliders icon) sets the date format, currency, and the exact Coupa expense type name for each category.

- **Entry mode**: click-to-copy each field in Coupa's order. `Enter` copies the next field, `1`–`6` copy a specific one, `↑`/`↓` change line. Nothing to install.
- **Bookmarklet**: drag the "Coupa Filler" button to your bookmarks bar, click **Copy for bookmarklet**, then click the bookmark in Coupa and paste. On first use, open the panel's **Setup** tab and use **Pick** to point at Coupa's Add Line / Save buttons and each field. The setup is saved in your browser for the Coupa site, and **Copy setup** / **Import setup** move it between computers.
- **Chrome extension** (`coupa-extension/`, load unpacked at `chrome://extensions`): same filler, without copy and paste. It runs only on this app's URL and on whatever tab you open it in.

The bookmarklet and the extension share one script, `public/coupa-filler.js`. `npm run build` copies it into `coupa-extension/` (via `scripts/sync-extension.mjs`), so edit only the copy in `public/`.
