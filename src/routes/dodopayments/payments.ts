import express from 'express';
import { getDodoPaymentsClient } from '../../lib/dodopayments';
import { scopeToUserDodoCustomer, getDodoCustomerIdForUser } from './scopeCustomer.js';

const router = express.Router();

router.use(scopeToUserDodoCustomer);

router.get('/', async (req, res) => {
    try {
        const { payment_id } = req.query;

        if (!payment_id || typeof payment_id !== 'string') {
            return res.status(400).json({ error: 'payment_id is required' });
        }

        const payment = await getDodoPaymentsClient().payments.retrieve(payment_id) as any;
        const linked = await getDodoCustomerIdForUser(req.userId!);
        const paymentCustomerId = payment?.customer_id || payment?.customer?.customer_id || payment?.customer?.id;
        if (!linked || paymentCustomerId !== linked) {
            return res.status(403).json({ error: 'Payment does not belong to authenticated user' });
        }
        res.json(payment);
    } catch (error) {
        console.error('Error fetching payment:', error);
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

        const payments = await getDodoPaymentsClient().payments.list(params);
        res.json(payments);
    } catch (error) {
        console.error('Error fetching payments list:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export { router as paymentsRouter };
