import { expect, test } from '@playwright/test';

test.describe('Shopping cart', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('adds an item', async ({ page }) => {
    await page.getByTestId('add-p1').click();

    await expect(page.getByTestId('cart-row-p1')).toBeVisible();
    await expect(page.getByTestId('qty-p1')).toHaveText('1');
  });

  test('removes an item when the quantity reaches zero', async ({ page }) => {
    await page.getByTestId('add-p2').click();
    await page.getByTestId('dec-p2').click();

    await expect(page.getByTestId('cart-empty')).toBeVisible();
  });

  /**
   * Deterministically flaky: it fails the first attempt and passes the retry.
   *
   * Real flakiness is a race you cannot reproduce on demand, which makes it
   * useless in a demo. Keying off the attempt number gives the same *signal* —
   * two attempts, two different outcomes, one commit and one configuration —
   * without the coin toss. EyesOnBug stores both attempts and marks the result
   * flaky, which is the behaviour worth showing.
   */
  test('updates the quantity', async ({ page }, testInfo) => {
    await page.getByTestId('add-p1').click();
    await page.getByTestId('inc-p1').click();

    if (testInfo.retry === 0) {
      // Stand-in for the race this test used to lose in CI.
      await expect(page.getByTestId('qty-p1')).toHaveText('3', { timeout: 2000 });
    }

    await expect(page.getByTestId('qty-p1')).toHaveText('2');
  });

  test('is empty to begin with', async ({ page }) => {
    await expect(page.getByTestId('cart-empty')).toBeVisible();
    await expect(page.getByTestId('cart-total')).toHaveText('—');
  });
});
