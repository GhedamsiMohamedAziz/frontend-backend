import { expect, test } from '@playwright/test';

test.describe('Checkout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('confirms an order', async ({ page }) => {
    await page.getByTestId('add-p1').click();
    await page.getByTestId('checkout').click();

    await expect(page.getByTestId('confirmation')).toBeVisible();
  });

  test('does nothing when the cart is empty', async ({ page }) => {
    await page.getByTestId('checkout').click();

    await expect(page.getByTestId('confirmation')).toBeHidden();
  });

  /**
   * Fails on chromium-fr only.
   *
   * The app formats every price with a full stop, which is right for en-US and
   * wrong for fr-FR. This is the single most useful shape of failure for a
   * demo: identical test, identical commit, one configuration red and one
   * green — which is only visible if results are stored per configuration.
   */
  test('shows prices in the local format', async ({ page }) => {
    const price = page.getByTestId('price-p1');
    const locale = await page.evaluate(() => navigator.language);

    if (locale.startsWith('fr')) {
      await expect(price).toHaveText('49,90 €');
    } else {
      await expect(price).toHaveText('$49.90');
    }
  });

  test('totals several items', async ({ page }) => {
    await page.getByTestId('add-p2').click();
    await page.getByTestId('inc-p2').click();

    await expect(page.getByTestId('cart-total')).toBeVisible();
  });

  // Skipped on purpose, so the report has an example of the fourth status.
  test.skip('supports gift wrapping', async () => {
    // Not implemented yet — tracked in ACME-4412.
  });
});
