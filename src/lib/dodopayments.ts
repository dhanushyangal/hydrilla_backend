import DodoPayments from 'dodopayments';
import { config } from '../config.js';

let dodopaymentsClient: DodoPayments | null = null;

export function getDodoPaymentsClient(): DodoPayments {
  if (!dodopaymentsClient) {
    const token = config.dodoPayment.apiKey;

    if (!token) {
      throw new Error(
        'DODO_PAYMENT_API_KEY environment variable is missing. Please check your .env file.'
      );
    }

    dodopaymentsClient = new DodoPayments({
      bearerToken: token,
      environment: config.dodoPayment.environment,
      webhookKey: config.dodoPayment.webhookSecret || null,
    });
  }

  return dodopaymentsClient;
}
