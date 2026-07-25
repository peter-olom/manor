export default async ({ page, artifacts }) => {
  console.log('Navigating to Manor review panel...');
  await page.goto('http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split');
  // Wait for the review panel toggle button to be present
  await page.waitForSelector('.butler-review-verdict-toggle', { state: 'visible', timeout: 10000 });
  console.log('Review panel toggle found.');

  // Take initial screenshot
  await page.screenshot({ path: 'qa-output/01-initial.png' });
  console.log('Saved initial screenshot.');

  // Locate the toggle button
  const toggleBtn = page.locator('.butler-review-verdict-toggle');
  // Locate the chevron span inside the toggle button
  const chevronSpan = toggleBtn.locator('.butler-review-card-chevron');
  await chevronSpan.waitFor({ state: 'visible', timeout: 5000 });
  // Locate the SVG inside the span
  const chevronIcon = chevronSpan.locator('svg');
  await chevronIcon.waitFor({ state: 'attached', timeout: 5000 });

  // Check the icon's bounding box and computed styles
  const toggleIconInfo = await page.evaluate(({ selector }) => {
    const svg = document.querySelector(selector);
    if (!svg) return { found: false };
    const rect = svg.getBoundingClientRect();
    const style = window.getComputedStyle(svg);
    return {
      found: true,
      width: rect.width,
      height: rect.height,
      widthCss: style.width,
      heightCss: style.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    };
  }, { selector: '.butler-review-verdict-toggle .butler-review-card-chevron svg' });

  if (!toggleIconInfo.found) {
    throw new Error('Chevron icon SVG not found');
  }
  const sizeOk = toggleIconInfo.width >= 14 && toggleIconInfo.height >= 14;
  const visible = toggleIconInfo.display !== 'none' && toggleIconInfo.visibility !== 'hidden' && parseFloat(toggleIconInfo.opacity) > 0;
  console.log(`Toggle icon size: ${toggleIconInfo.width}x${toggleIconInfo.height} (CSS: ${toggleIconInfo.widthCss} x ${toggleIconInfo.heightCss}), visible: ${visible}, size >=14px: ${sizeOk}`);

  // Click the toggle to expand the panel
  await toggleBtn.click();
  // Wait for the expanded panel to appear (we can wait for the body of the verdict)
  await page.waitForSelector('.butler-review-verdict-body', { state: 'visible', timeout: 5000 });
  console.log('Review panel expanded.');

  // Take screenshot after expansion
  await page.screenshot({ path: 'qa-output/02-expanded.png' });
  console.log('Saved expanded screenshot.');

  // Check chevron icons inside each review card toggle buttons (both in the main card and history cards)
  const iconSelectors = '.butler-review-card-toggle .butler-review-card-chevron svg';
  const iconsInfo = await page.evaluate(({ selector }) => {
    const svgs = Array.from(document.querySelectorAll(selector));
    return svgs.map((svg, index) => {
      const rect = svg.getBoundingClientRect();
      const style = window.getComputedStyle(svg);
      return {
        index,
        width: rect.width,
        height: rect.height,
        widthCss: style.width,
        heightCss: style.height,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
      };
    });
  }, { selector: iconSelectors });

  console.log('Review card toggle icons info:', JSON.stringify(iconsInfo, null, 2));

  let allIconsOk = true;
  for (const info of iconsInfo) {
    const sizeOk = info.width >= 14 && info.height >= 14;
    const visible = info.display !== 'none' && info.visibility !== 'hidden' && parseFloat(info.opacity) > 0;
    if (!sizeOk) {
      console.error(`Icon ${info.index}: size ${info.width}x${info.height} is less than 14px`);
      allIconsOk = false;
    }
    if (!visible) {
      console.error(`Icon ${info.index}: not visible (display=${info.display}, visibility=${info.visibility}, opacity=${info.opacity})`);
      allIconsOk = false;
    }
  }

  // Also check the toggle icon in the expanded state (it should now be ChevronDown)
  const expandedToggleInfo = await page.evaluate(({ selector }) => {
    const svg = document.querySelector(selector);
    if (!svg) return { found: false };
    const rect = svg.getBoundingClientRect();
    const style = window.getComputedStyle(svg);
    return {
      found: true,
      width: rect.width,
      height: rect.height,
      widthCss: style.width,
      heightCss: style.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    };
  }, { selector: '.butler-review-verdict-toggle .butler-review-card-chevron svg' });
  console.log('Expanded toggle icon info:', expandedToggleInfo);
  if (!expandedToggleInfo.found) {
    throw new Error('Expanded toggle button not found');
  }
  const expandedSizeOk = expandedToggleInfo.width >= 14 && expandedToggleInfo.height >= 14;
  const expandedVisible = expandedToggleInfo.display !== 'none' && expandedToggleInfo.visibility !== 'hidden' && parseFloat(expandedToggleInfo.opacity) > 0;
  console.log(`Expanded toggle icon size: ${expandedToggleInfo.width}x${expandedToggleInfo.height}, visible: ${expandedVisible}, size >=14px: ${expandedSizeOk}`);

  // Determine overall success
  const toggleOk = sizeOk && visible;
  const expandedOk = expandedSizeOk && expandedVisible;
  const iconsOk = allIconsOk;

  const success = toggleOk && expandedOk && iconsOk;
  console.log('Overall check:', success ? 'PASS' : 'FAIL');
  console.log('  Toggle icon:', toggleOk ? 'PASS' : 'FAIL');
  console.log('  Expanded toggle:', expandedOk ? 'PASS' : 'FAIL');
  console.log('  Inner icons:', iconsOk ? 'PASS' : 'FAIL');

  // Return an object with the results for the script
  return {
    success,
    toggleOk,
    expandedOk,
    iconsOk,
    details: {
      toggle: toggleIconInfo,
      expandedToggle: expandedToggleInfo,
      innerIcons: iconsInfo,
    }
  };
};