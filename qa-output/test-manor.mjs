export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'networkidle' });
  
  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  
  // Wait a bit for any delayed errors
  await page.waitForTimeout(2000);
  
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
  // We'll try to see if there are elements with certain class names
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
  
  // Output results
  return {
    title,
    bodyLength: bodyText.length,
    consoleErrors,
    butlerExists,
    workerExists,
    screenshot: 'qa-output/full-page.png'
  };
};