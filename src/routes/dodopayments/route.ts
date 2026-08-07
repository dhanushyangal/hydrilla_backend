import express from 'express';
import { checkoutRouter } from './checkout';
import { customerRouter } from './customer';
import { paymentsRouter } from './payments';
import { productsRouter } from './products';
import { subscriptionsRouter } from './subscriptions';
import { webhookRouter } from './webhook';
import { requireAuth } from '../../middleware/auth.js';

const router = express.Router();

// Webhooks are verified by signature only (no Clerk auth)
router.use('/webhook', webhookRouter);

// All other Dodo proxy routes require a logged-in user
router.use('/checkout', requireAuth, checkoutRouter);
router.use('/customer', requireAuth, customerRouter);
router.use('/payments', requireAuth, paymentsRouter);
router.use('/products', requireAuth, productsRouter);
router.use('/subscriptions', requireAuth, subscriptionsRouter);

export { router as dodopaymentsRouter };
