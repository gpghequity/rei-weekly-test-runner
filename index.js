const https = require('https');
const http = require('http');

const LIBRARY_URL = process.env.LIBRARY_URL || 'https://sublime-friendship-production.up.railway.app';
const PASSWORD = process.env.LIBRARY_PASSWORD || 'Savannah050810!';

async function getAllServices() {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/assets', LIBRARY_URL);
    const client = LIBRARY_URL.startsWith('https') ? https : http;

    const req = client.get(url, {
      headers: { 'X-Library-Password': PASSWORD }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.assets || []);
        } catch (e) {
          console.error('Failed to parse assets:', e.message);
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function testService(asset) {
  const start = Date.now();
  try {
    const url = new URL(asset.url || `https://${asset.id}-production.up.railway.app`);
    const client = url.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      const req = client.get(url, {
        timeout: 5000
      }, (res) => {
        const duration = Date.now() - start;
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          asset_id: asset.id,
          status: ok ? 'pass' : 'fail',
          response_time_ms: duration,
          response_code: res.statusCode,
          passed: ok ? 1 : 0,
          failed: ok ? 0 : 1
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          asset_id: asset.id,
          status: 'fail',
          error: 'timeout',
          passed: 0,
          failed: 1
        });
      });

      req.on('error', (err) => {
        resolve({
          asset_id: asset.id,
          status: 'fail',
          error: err.message || 'connection_error',
          passed: 0,
          failed: 1
        });
      });
    });
  } catch (err) {
    return {
      asset_id: asset.id,
      status: 'fail',
      error: err.message,
      passed: 0,
      failed: 1
    };
  }
}

async function recordTestRun(summary) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      run_date: new Date().toISOString(),
      total_assets_tested: summary.total_assets_tested,
      total_tests: summary.total_tests,
      total_passed: summary.total_passed,
      total_failed: summary.total_failed,
      overall_coverage: parseFloat(summary.overall_coverage),
      status: summary.total_failed === 0 ? 'pass' : 'fail'
    });

    const url = new URL('/api/test-runs', LIBRARY_URL);
    const client = LIBRARY_URL.startsWith('https') ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Library-Password': PASSWORD
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve());
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function recordTestResult(result) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      asset_id: result.asset_id,
      test_suite: 'health_check',
      total_tests: 1,
      passed: result.passed,
      failed: result.failed,
      skipped: 0,
      coverage_percent: result.passed * 100,
      run_date: new Date().toISOString(),
      status: result.status,
      logs: result.error || JSON.stringify({response_code: result.response_code, response_time_ms: result.response_time_ms})
    });

    const url = new URL('/api/test-results', LIBRARY_URL);
    const client = LIBRARY_URL.startsWith('https') ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Library-Password': PASSWORD
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve());
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runWeeklyTests() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting weekly platform tests...`);

  try {
    const services = await getAllServices();
    console.log(`[${new Date().toISOString()}] Found ${services.length} services to test`);

    const results = [];
    let completed = 0;

    for (const service of services) {
      try {
        const result = await testService(service);
        results.push(result);
        completed++;
        if (completed % 10 === 0) {
          console.log(`[${new Date().toISOString()}] Tested ${completed}/${services.length}...`);
        }
      } catch (err) {
        console.error(`Error testing ${service.id}:`, err.message);
        results.push({
          asset_id: service.id,
          status: 'fail',
          error: err.message,
          passed: 0,
          failed: 1
        });
      }
    }

    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const coverage = services.length > 0 ? ((passed / services.length) * 100).toFixed(1) : '0';

    const summary = {
      total_assets_tested: services.length,
      total_tests: services.length,
      total_passed: passed,
      total_failed: failed,
      overall_coverage: coverage
    };

    console.log(`[${new Date().toISOString()}] Recording test run summary...`);
    await recordTestRun(summary);

    console.log(`[${new Date().toISOString()}] Recording ${results.length} individual test results...`);
    let recorded = 0;
    for (const result of results) {
      try {
        await recordTestResult(result);
        recorded++;
        if (recorded % 20 === 0) {
          console.log(`[${new Date().toISOString()}] Recorded ${recorded}/${results.length}...`);
        }
      } catch (err) {
        console.error(`Error recording result for ${result.asset_id}:`, err.message);
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n${new Date().toISOString()} ✅ WEEKLY TESTS COMPLETE`);
    console.log(`   Total services: ${services.length}`);
    console.log(`   Passed: ${passed}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Coverage: ${coverage}%`);
    console.log(`   Duration: ${duration}s`);

    if (failed > 0) {
      console.error(`\n⚠️  ${failed} SERVICES FAILED:`);
      results.filter(r => r.status === 'fail').forEach(r => {
        console.error(`   - ${r.asset_id}: ${r.error}`);
      });
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ WEEKLY TEST RUN FAILED:`, err.message);
    process.exit(1);
  }
}

if (process.env.RUN_TESTS === 'true') {
  runWeeklyTests();
} else {
  console.log('Weekly test runner ready. Set RUN_TESTS=true to start.');
  console.log(`Library URL: ${LIBRARY_URL}`);
}

module.exports = { runWeeklyTests };
