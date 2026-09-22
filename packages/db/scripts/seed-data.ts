/**
 * The shape of the demo world.
 *
 * Kept separate from the insert logic so the *story* the seed tells is
 * reviewable on its own: which tests are reliably green, which one flakes,
 * which feature regressed last week, and which failures cluster together.
 * A seed that is uniformly random proves nothing about the UI.
 */

export interface FeatureSpec {
  key: string;
  name: string;
  team: string;
}

export interface TestSpec {
  feature: string;
  file: string;
  title: string;
  /** How this test behaves over the seeded window. */
  profile: 'stable' | 'flaky' | 'regressed' | 'broken' | 'slow' | 'skipped';
  baseDurationMs: number;
  params?: Record<string, unknown>;
  tags?: string[];
}

export interface ProjectSpec {
  slug: string;
  name: string;
  repo: string;
  features: FeatureSpec[];
  tests: TestSpec[];
  browsers: string[];
  locales: string[];
  runCount: number;
}

export const TEAMS = ['payments', 'search', 'accounts', 'platform'] as const;

/** Realistic failures, chosen so several distinct tests share one signature. */
export const ERROR_CATALOG = {
  checkoutTimeout: {
    type: 'TimeoutError',
    message:
      "locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Place order' })",
    stack: [
      '    at CheckoutPage.placeOrder (/home/runner/work/storefront/e2e/pages/checkout.page.ts:87:22)',
      '    at /home/runner/work/storefront/e2e/checkout.spec.ts:42:5',
      '    at node_modules/@playwright/test/lib/worker.js:112:9',
    ].join('\n'),
  },
  priceMismatch: {
    type: 'AssertionError',
    message: 'expected "€49,90" to equal "€49.90"',
    stack: [
      '    at Object.toEqual (/home/runner/work/storefront/e2e/checkout.spec.ts:118:31)',
    ].join('\n'),
  },
  staleSession: {
    type: 'Error',
    message:
      'Navigation failed: net::ERR_CONNECTION_REFUSED at https://staging.example.com:8443/cart',
    stack: [
      '    at CartPage.open (/home/runner/work/storefront/e2e/pages/cart.page.ts:19:12)',
    ].join('\n'),
  },
  searchEmpty: {
    type: 'AssertionError',
    message: 'expected search results to have length greater than 0, got 0',
    stack: [
      '    at SearchPage.expectResults (/home/runner/work/storefront/e2e/pages/search.page.ts:54:18)',
      '    at /home/runner/work/storefront/e2e/search.spec.ts:23:5',
    ].join('\n'),
  },
  flakyToast: {
    type: 'TimeoutError',
    message: "locator.waitFor: Timeout 5000ms exceeded waiting for getByTestId('toast')",
    stack: ['    at expectToast (/home/runner/work/storefront/e2e/support/toast.ts:11:9)'].join(
      '\n',
    ),
  },
} as const;

export type ErrorKey = keyof typeof ERROR_CATALOG;

const storefrontFeatures: FeatureSpec[] = [
  { key: 'checkout', name: 'Checkout', team: 'payments' },
  { key: 'cart', name: 'Shopping cart', team: 'payments' },
  { key: 'search', name: 'Product search', team: 'search' },
  { key: 'account', name: 'Account & profile', team: 'accounts' },
  { key: 'pdp', name: 'Product detail page', team: 'search' },
];

const storefrontTests: TestSpec[] = [
  // Checkout — where the interesting failures live.
  {
    feature: 'checkout',
    file: 'e2e/checkout.spec.ts',
    title: 'pays with a saved card',
    profile: 'stable',
    baseDurationMs: 8200,
    tags: ['smoke', 'critical'],
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout.spec.ts',
    title: 'pays with a new card',
    profile: 'regressed',
    baseDurationMs: 9100,
    tags: ['critical'],
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout.spec.ts',
    title: 'applies a discount code',
    profile: 'regressed',
    baseDurationMs: 6400,
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout.spec.ts',
    title: 'shows localized prices',
    profile: 'broken',
    baseDurationMs: 5200,
    tags: ['i18n'],
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout.spec.ts',
    title: 'blocks an expired card',
    profile: 'stable',
    baseDurationMs: 4800,
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout-guest.spec.ts',
    title: 'guest checkout completes',
    profile: 'flaky',
    baseDurationMs: 11400,
    tags: ['critical'],
  },
  {
    feature: 'checkout',
    file: 'e2e/checkout-guest.spec.ts',
    title: 'guest is offered an account',
    profile: 'stable',
    baseDurationMs: 3900,
  },

  // Cart
  {
    feature: 'cart',
    file: 'e2e/cart.spec.ts',
    title: 'adds an item',
    profile: 'stable',
    baseDurationMs: 2400,
    tags: ['smoke'],
  },
  {
    feature: 'cart',
    file: 'e2e/cart.spec.ts',
    title: 'removes an item',
    profile: 'stable',
    baseDurationMs: 2100,
  },
  {
    feature: 'cart',
    file: 'e2e/cart.spec.ts',
    title: 'updates quantity',
    profile: 'flaky',
    baseDurationMs: 2800,
  },
  {
    feature: 'cart',
    file: 'e2e/cart.spec.ts',
    title: 'persists across sessions',
    profile: 'stable',
    baseDurationMs: 5600,
  },
  {
    feature: 'cart',
    file: 'e2e/cart.spec.ts',
    title: 'merges guest cart on login',
    profile: 'stable',
    baseDurationMs: 7200,
  },

  // Search — one slow test, one parameterised set.
  {
    feature: 'search',
    file: 'e2e/search.spec.ts',
    title: 'finds a product by name',
    profile: 'stable',
    baseDurationMs: 3100,
    tags: ['smoke'],
  },
  {
    feature: 'search',
    file: 'e2e/search.spec.ts',
    title: 'filters by category',
    profile: 'stable',
    baseDurationMs: 4200,
  },
  {
    feature: 'search',
    file: 'e2e/search.spec.ts',
    title: 'handles no results',
    profile: 'stable',
    baseDurationMs: 2200,
  },
  {
    feature: 'search',
    file: 'e2e/search.spec.ts',
    title: 'ranks relevant results first',
    profile: 'slow',
    baseDurationMs: 21500,
  },
  {
    feature: 'search',
    file: 'e2e/search-facets.spec.ts',
    title: 'facet count is correct',
    profile: 'flaky',
    baseDurationMs: 6100,
  },
  {
    feature: 'search',
    file: 'e2e/search-i18n.spec.ts',
    title: 'searches in locale',
    profile: 'stable',
    baseDurationMs: 3400,
    params: { query: 'chaussures' },
    tags: ['i18n'],
  },
  {
    feature: 'search',
    file: 'e2e/search-i18n.spec.ts',
    title: 'searches in locale',
    profile: 'regressed',
    baseDurationMs: 3400,
    params: { query: 'schuhe' },
    tags: ['i18n'],
  },

  // Account
  {
    feature: 'account',
    file: 'e2e/account.spec.ts',
    title: 'signs in with email',
    profile: 'stable',
    baseDurationMs: 3300,
    tags: ['smoke'],
  },
  {
    feature: 'account',
    file: 'e2e/account.spec.ts',
    title: 'signs out',
    profile: 'stable',
    baseDurationMs: 1800,
  },
  {
    feature: 'account',
    file: 'e2e/account.spec.ts',
    title: 'resets a password',
    profile: 'stable',
    baseDurationMs: 8900,
  },
  {
    feature: 'account',
    file: 'e2e/account.spec.ts',
    title: 'updates the shipping address',
    profile: 'stable',
    baseDurationMs: 5100,
  },
  {
    feature: 'account',
    file: 'e2e/account.spec.ts',
    title: 'deletes the account',
    profile: 'skipped',
    baseDurationMs: 0,
  },

  // PDP
  {
    feature: 'pdp',
    file: 'e2e/pdp.spec.ts',
    title: 'renders gallery',
    profile: 'stable',
    baseDurationMs: 2900,
  },
  {
    feature: 'pdp',
    file: 'e2e/pdp.spec.ts',
    title: 'switches variant',
    profile: 'stable',
    baseDurationMs: 3600,
  },
  {
    feature: 'pdp',
    file: 'e2e/pdp.spec.ts',
    title: 'shows stock status',
    profile: 'flaky',
    baseDurationMs: 2700,
  },
  {
    feature: 'pdp',
    file: 'e2e/pdp.spec.ts',
    title: 'shows delivery estimate',
    profile: 'stable',
    baseDurationMs: 3100,
  },
];

const checkoutApiFeatures: FeatureSpec[] = [
  { key: 'payments', name: 'Payment processing', team: 'payments' },
  { key: 'orders', name: 'Order lifecycle', team: 'payments' },
  { key: 'webhooks', name: 'Webhooks', team: 'platform' },
];

const checkoutApiTests: TestSpec[] = [
  {
    feature: 'payments',
    file: 'tests/payments.spec.ts',
    title: 'authorizes a payment',
    profile: 'stable',
    baseDurationMs: 900,
  },
  {
    feature: 'payments',
    file: 'tests/payments.spec.ts',
    title: 'captures a payment',
    profile: 'stable',
    baseDurationMs: 1100,
  },
  {
    feature: 'payments',
    file: 'tests/payments.spec.ts',
    title: 'refunds a payment',
    profile: 'flaky',
    baseDurationMs: 1400,
  },
  {
    feature: 'payments',
    file: 'tests/payments.spec.ts',
    title: 'rejects a declined card',
    profile: 'stable',
    baseDurationMs: 700,
  },
  {
    feature: 'orders',
    file: 'tests/orders.spec.ts',
    title: 'creates an order',
    profile: 'stable',
    baseDurationMs: 800,
  },
  {
    feature: 'orders',
    file: 'tests/orders.spec.ts',
    title: 'cancels an order',
    profile: 'stable',
    baseDurationMs: 850,
  },
  {
    feature: 'orders',
    file: 'tests/orders.spec.ts',
    title: 'transitions to shipped',
    profile: 'regressed',
    baseDurationMs: 1200,
  },
  {
    feature: 'webhooks',
    file: 'tests/webhooks.spec.ts',
    title: 'retries a failed delivery',
    profile: 'slow',
    baseDurationMs: 15800,
  },
  {
    feature: 'webhooks',
    file: 'tests/webhooks.spec.ts',
    title: 'verifies the signature',
    profile: 'stable',
    baseDurationMs: 600,
  },
];

const mobileWebFeatures: FeatureSpec[] = [
  { key: 'nav', name: 'Mobile navigation', team: 'platform' },
  { key: 'checkout-mobile', name: 'Mobile checkout', team: 'payments' },
];

const mobileWebTests: TestSpec[] = [
  {
    feature: 'nav',
    file: 'e2e/mobile-nav.spec.ts',
    title: 'opens the menu drawer',
    profile: 'stable',
    baseDurationMs: 1900,
  },
  {
    feature: 'nav',
    file: 'e2e/mobile-nav.spec.ts',
    title: 'search is reachable in one tap',
    profile: 'stable',
    baseDurationMs: 2200,
  },
  {
    feature: 'checkout-mobile',
    file: 'e2e/mobile-checkout.spec.ts',
    title: 'completes on a phone viewport',
    profile: 'flaky',
    baseDurationMs: 12800,
    tags: ['critical'],
  },
  {
    feature: 'checkout-mobile',
    file: 'e2e/mobile-checkout.spec.ts',
    title: 'applies Apple Pay',
    profile: 'broken',
    baseDurationMs: 6200,
  },
];

export const PROJECTS: ProjectSpec[] = [
  {
    slug: 'storefront',
    name: 'Storefront E2E',
    repo: 'acme-retail/storefront',
    features: storefrontFeatures,
    tests: storefrontTests,
    browsers: ['chromium', 'firefox', 'webkit'],
    locales: ['en-US', 'fr-FR', 'de-DE'],
    runCount: 28,
  },
  {
    slug: 'checkout-api',
    name: 'Checkout API',
    repo: 'acme-retail/checkout-api',
    features: checkoutApiFeatures,
    tests: checkoutApiTests,
    browsers: ['chromium'],
    locales: ['en-US'],
    runCount: 20,
  },
  {
    slug: 'mobile-web',
    name: 'Mobile Web',
    repo: 'acme-retail/mobile-web',
    features: mobileWebFeatures,
    tests: mobileWebTests,
    browsers: ['chromium', 'webkit'],
    locales: ['en-US', 'fr-FR'],
    runCount: 12,
  },
];

export const BRANCHES = ['main', 'main', 'main', 'release/2026.09', 'feat/new-checkout'] as const;

export const COMMIT_MESSAGES = [
  'fix(checkout): guard against a missing billing address',
  'feat(search): boost exact title matches',
  'chore(deps): bump playwright to 1.49',
  'refactor(cart): extract quantity stepper',
  'fix(i18n): use narrow no-break space in fr-FR prices',
  'feat(account): allow address nicknames',
  'perf(pdp): lazy-load the gallery',
] as const;
