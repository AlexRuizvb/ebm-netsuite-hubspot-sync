# EBM NetSuite-HubSpot AR Sync

Automatically syncs Accounts Receivable data from NetSuite to HubSpot daily.

## What it does

- Pulls all customers with open AR balances from NetSuite
- Matches them to HubSpot Companies by name
- Updates these HubSpot properties:
  - `netsuite_customer_id`
  - `total_ar_balance`
  - `past_due_amount`

## Deploy to Render

### Step 1: Create GitHub Repository

1. Go to https://github.com/new
2. Name: `ebm-netsuite-hubspot-sync`
3. Make it Private
4. Upload these files

### Step 2: Deploy on Render

1. Go to https://dashboard.render.com
2. Click "New" → "Web Service"
3. Connect your GitHub repo
4. Configure:
   - Name: `ebm-netsuite-hubspot-sync`
   - Runtime: Node
   - Build Command: (leave empty)
   - Start Command: `node src/index.js`

### Step 3: Add Environment Variables

In Render dashboard, add these environment variables:

| Key | Value |
|-----|-------|
| NETSUITE_ACCOUNT_ID | 7882010 |
| NETSUITE_CONSUMER_KEY | (your key) |
| NETSUITE_CONSUMER_SECRET | (your secret) |
| NETSUITE_TOKEN_ID | (your token) |
| NETSUITE_TOKEN_SECRET | (your secret) |
| HUBSPOT_ACCESS_TOKEN | (your HubSpot token) |

### Step 4: Set Up Cron Job

1. In Render, click "New" → "Cron Job"
2. Connect same repo
3. Schedule: `0 11 * * *` (6 AM EST / 11 AM UTC)
4. Command: `node -e "import('./src/index.js').then(m => m.syncARData())"`
5. Add same environment variables

## Manual Sync

POST to `/sync` endpoint to run immediately:

```bash
curl -X POST https://your-service.onrender.com/sync
```

## Health Check

GET `/health` returns service status.
