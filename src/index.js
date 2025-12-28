import crypto from 'crypto';
import https from 'https';

// ============ CONFIGURATION ============
const config = {
  netsuite: {
    accountId: process.env.NETSUITE_ACCOUNT_ID || '7882010',
    consumerKey: process.env.NETSUITE_CONSUMER_KEY,
    consumerSecret: process.env.NETSUITE_CONSUMER_SECRET,
    tokenId: process.env.NETSUITE_TOKEN_ID,
    tokenSecret: process.env.NETSUITE_TOKEN_SECRET,
  },
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  }
};

// ============ NETSUITE OAUTH 1.0 ============
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort().map(key => 
    `${percentEncode(key)}=${percentEncode(params[key])}`
  ).join('&');
  
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams)
  ].join('&');
  
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  
  return crypto.createHmac('sha256', signingKey)
    .update(signatureBase)
    .digest('base64');
}

function generateAuthHeader(method, url, consumerKey, consumerSecret, tokenId, tokenSecret, realm) {
  const nonce = generateNonce();
  const timestamp = generateTimestamp();
  
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: '1.0'
  };
  
  const signature = generateSignature(method, url, params, consumerSecret, tokenSecret);
  params.oauth_signature = signature;
  
  const authHeader = 'OAuth realm="' + realm + '", ' +
    Object.keys(params).map(key => `${key}="${percentEncode(params[key])}"`).join(', ');
  
  return authHeader;
}

// ============ NETSUITE API CALLS ============
async function netsuiteRequest(method, endpoint, body = null) {
  const accountId = config.netsuite.accountId.replace(/_/g, '-');
  const baseUrl = `https://${accountId}.suitetalk.api.netsuite.com`;
  const url = `${baseUrl}${endpoint}`;
  const realm = config.netsuite.accountId.toUpperCase();
  
  const authHeader = generateAuthHeader(
    method,
    url,
    config.netsuite.consumerKey,
    config.netsuite.consumerSecret,
    config.netsuite.tokenId,
    config.netsuite.tokenSecret,
    realm
  );
  
  const options = {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Prefer': 'transient'
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getARData() {
  const query = `
    SELECT 
      t.entity AS customer_id,
      e.companyname AS customer_name,
      e.email,
      SUM(CASE WHEN t.daysopen > 0 THEN t.foreignamountunpaid ELSE 0 END) AS past_due_amount,
      SUM(t.foreignamountunpaid) AS total_ar_balance
    FROM transaction t
    JOIN entity e ON t.entity = e.id
    WHERE t.type = 'CustInvc'
      AND t.mainline = 'T'
      AND t.foreignamountunpaid > 0
    GROUP BY t.entity, e.companyname, e.email
    ORDER BY total_ar_balance DESC
  `;
  
  const result = await netsuiteRequest('POST', '/services/rest/query/v1/suiteql', { q: query });
  return result.items || [];
}

// ============ HUBSPOT API CALLS ============
async function hubspotRequest(method, endpoint, body = null) {
  const url = `https://api.hubapi.com${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${config.hubspot.accessToken}`,
      'Content-Type': 'application/json'
    }
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function searchCompanyByName(name) {
  const searchBody = {
    filterGroups: [{
      filters: [{
        propertyName: 'name',
        operator: 'CONTAINS_TOKEN',
        value: name.split(' ')[0] // Search by first word
      }]
    }],
    properties: ['name', 'netsuite_customer_id', 'total_ar_balance', 'past_due_amount'],
    limit: 10
  };
  
  const result = await hubspotRequest('POST', '/crm/v3/objects/companies/search', searchBody);
  return result.results || [];
}

async function updateCompany(companyId, properties) {
  return hubspotRequest('PATCH', `/crm/v3/objects/companies/${companyId}`, { properties });
}

// ============ SYNC LOGIC ============
async function syncARData() {
  console.log('Starting AR sync:', new Date().toISOString());
  
  // Get AR data from NetSuite
  console.log('Fetching AR data from NetSuite...');
  const arData = await getARData();
  console.log(`Found ${arData.length} customers with AR balances`);
  
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  
  for (const customer of arData) {
    try {
      // Search for matching company in HubSpot
      const companies = await searchCompanyByName(customer.customer_name);
      
      if (companies.length > 0) {
        // Find best match
        const match = companies.find(c => 
          c.properties.name.toLowerCase().includes(customer.customer_name.toLowerCase().split(' ')[0])
        ) || companies[0];
        
        // Update the company
        await updateCompany(match.id, {
          netsuite_customer_id: customer.customer_id.toString(),
          total_ar_balance: Math.round(customer.total_ar_balance * 100) / 100,
          past_due_amount: Math.round(customer.past_due_amount * 100) / 100
        });
        
        console.log(`✓ Updated: ${customer.customer_name} → ${match.properties.name}`);
        updated++;
      } else {
        console.log(`✗ Not found in HubSpot: ${customer.customer_name}`);
        notFound++;
      }
      
      // Rate limit delay
      await new Promise(r => setTimeout(r, 100));
      
    } catch (err) {
      console.error(`Error processing ${customer.customer_name}:`, err.message);
      errors++;
    }
  }
  
  console.log('\n=== Sync Complete ===');
  console.log(`Updated: ${updated}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Errors: ${errors}`);
  
  return { updated, notFound, errors };
}

// ============ WEB SERVER FOR RENDER ============
import http from 'http';

const server = http.createServer(async (req, res) => {
  if (req.url === '/sync' && req.method === 'POST') {
    try {
      const result = await syncARData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>EBM NetSuite-HubSpot Sync</h1>
      <p>POST /sync - Run sync manually</p>
      <p>GET /health - Health check</p>
      <p>Cron runs daily at 6 AM EST</p>
    `);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Run sync on startup if SYNC_ON_START is set
if (process.env.SYNC_ON_START === 'true') {
  syncARData().catch(console.error);
}

export { syncARData };
