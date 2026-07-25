export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  console.log('Navigating to', url);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.error('Navigation error:', e.message);
    // still continue to capture state
  }
  
  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  
  // Wait for any delayed errors
  await page.waitForTimeout(3000);
  
  // Take full page screenshot
  await page.screenshot({ path: 'qa-output/full-page.png', fullPage: true });
  console.log('Screenshot saved to qa-output/full-page.png');
  
  // Get page title and visible text snippet
  const title = await page.title();
  console.log('Page title:', title);
  
  // Check if body has content
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Body text length:', bodyText.length);
  if (bodyText.length === 0) {
    console.log('Body appears empty');
  } else {
    console.log('Body preview:', bodyText.slice(0, 200));
  }
  
  // Check for Butler and Worker pane selectors (guess)
  const butlerExists = await page.evaluate(() => {
    const el = document.querySelector('.butler-pane, #butler, [data-pane="butler"]');
    return !!el;
  });
  const workerExists = await page.evaluate(() => {
    const el = document.querySelector('.worker-pane, #worker, [data-pane="worker"]');
    return !!el;
  });
  console.log('Butler pane present:', butlerExists);
  console.log('Worker pane present:', workerExists);
  
  // Also try to see if there are any obvious error messages in the UI
  const errorElements = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="error"], [id*="error"], .error, .alert-danger'));
    return els.map(el => el.innerText).filter(t => t.trim().length > 0);
  });
  console.log('Potential error elements text:', errorElements);
  
  // Output results
  return {
    title,
    bodyLength: bodyText.length,
    consoleErrors,
    butlerExists,
    workerExists,
    errorElements,
    screenshot: 'qa-output/full-page.png'
  };
};