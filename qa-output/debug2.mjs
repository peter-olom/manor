export default async ({ page }) => {
  const url = 'http://127.0.0.1:8180/?session=53f3f8d9-b1f2-41a1-805e-3d16662aa9f4&view=split';
  await page.goto(url);
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const verdictEls = Array.from(document.querySelectorAll('*')).filter(el => 
      el.className && (/\bverdict\b/i.test(el.className) || /\bbadge\b/i.test(el.className))
    );
    const badgeEls = Array.from(document.querySelectorAll('*')).filter(el => 
      el.textContent && el.textContent.trim() === 'Accepted'
    );
    return {
      verdictCount: verdictEls.length,
      verdictSamples: verdictEls.slice(0,5).map(el => ({
        tag: el.tagName,
        class: el.className,
        id: el.id,
        text: el.textContent.trim().slice(0,100)
      })),
      badgeCount: badgeEls.length,
      badgeSamples: badgeEls.slice(0,5).map(el => ({
        tag: el.tagName,
        class: el.className,
        id: el.id,
        text: el.textContent.trim()
      }))
    };
  });
  console.log(info);
};