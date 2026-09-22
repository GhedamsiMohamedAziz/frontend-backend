import { expect, test } from '@playwright/test';

test.describe('Product search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('lists every product by default', async ({ page }) => {
    await expect(page.getByTestId('product-p1')).toBeVisible();
    await expect(page.locator('.product')).toHaveCount(4);
  });

  test('filters by name', async ({ page }) => {
    await page.getByTestId('search').fill('socks');

    await expect(page.locator('.product')).toHaveCount(1);
    await expect(page.getByTestId('product-p2')).toBeVisible();
  });

  test('tells the user when nothing matches', async ({ page }) => {
    await page.getByTestId('search').fill('submarine');

    await expect(page.getByTestId('no-results')).toBeVisible();
    await expect(page.locator('.product')).toHaveCount(0);
  });
});
