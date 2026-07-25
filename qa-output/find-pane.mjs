import { promises as fs } from 'fs';

export default async ({ page, artifacts }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(5000);

  // Take a screenshot for reference
  await page.screenshot({ path: artifacts.dir + '/find-pane.png', fullPage: true });

  // Get the viewport size
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));

  // Find all elements that are in the right half and have decent size
  const candidates = await page.evaluate((viewportWidth) => {
    const els = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      // Ignore elements that are too small
      if (rect.width < 50 || rect.height < 50) continue;
      // Check if the element is mostly in the right half (left edge > halfway)
      if (rect.left > viewportWidth / 2) {
        els.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          text: el.textContent ? el.textContent.trim().substring(0, 100) : ''
        });
      }
    }
    // Sort by area descending
    els.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return els.slice(0, 10); // top 10
  }, viewport.width);

  await fs.writeFile(artifacts.dir + '/right-pane-candidates.json', JSON.stringify(candidates, null, 2));

  // Also look for any element containing "Task outputs"
  const taskEls = await page.evaluate(() => {
    const matches = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.textContent && el.textContent.includes('Task outputs')) {
        matches.push({
          tag: el.tagName,
          class: el.className,
          id: el.id,
          text: el.textContent.trim().substring(0, 200)
        });
      }
    }
    return matches;
  });
  await fs.writeFile(artifacts.dir + '/task-outputs-elements.json', JSON.stringify(taskEls, null, 2));

  // Try to find the scroll container for the Worker pane by looking for overflow
  const scrollContainers = await page.evaluate(() => {
    const scrolls = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) {
          scrolls.push({
            tag: el.tagName,
            class: el.className,
            id: el.id,
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }
    }
    return scrolls;
  });
  await fs.writeFile(artifacts.dir + '/scroll-containers.json', JSON.stringify(scrollContainers, null, 2));
};