import express from 'express';
import { getDodoPaymentsClient } from '../../lib/dodopayments';
import { scopeToUserDodoCustomer, getDodoCustomerIdForUser } from './scopeCustomer.js';

const router = express.Router();

router.use(scopeToUserDodoCustomer);

router.get('/', async (req, res) => {
    try {
        const { subscription_id } = req.query;

        if (!subscription_id || typeof subscription_id !== 'string') {
            return res.status(400).json({ error: 'subscription_id is required' });
        }

        const subscription = await getDodoPaymentsClient().subscriptions.retrieve(subscription_id) as any;
        const linked = await getDodoCustomerIdForUser(req.userId!);
        const subCustomerId = subscription?.customer_id || subscription?.customer?.customer_id || subscription?.customer?.id;
        if (!linked || subCustomerId !== linked) {
            return res.status(403).json({ error: 'Subscription does not belong to authenticated user' });
        }
        res.json(subscription);
    } catch (error) {
        console.error('Error fetching subscription:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/list', async (req, res) => {
    try {
        const { customer_id, limit, starting_after } = req.query;

        const params: any = {};
        if (customer_id && typeof customer_id === 'string') {
            params.customer_id = customer_id;
        } else {
            return res.status(400).json({ error: 'No Dodo customer linked to this user' });
        }
        if (limit && typeof limit === 'string') {
            params.limit = parseInt(limit);
        }
        if (starting_after && typeof starting_after === 'string') {
            params.starting_after = starting_after;
        }

        const subscriptions = await getDodoPaymentsClient().subscriptions.list(params);
        res.json(subscriptions);
    } catch (error) {
        console.error('Error fetching subscriptions list:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export { router as subscriptionsRouter };
