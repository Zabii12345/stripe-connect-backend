require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is missing');
  process.exit(1);
}
const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// ============================================================
// Helper: Verify Firebase ID Token
// ============================================================
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ============================================================
// 1. Create a Stripe Express Connected Account
//    (business user onboards their OWN Stripe account)
// ============================================================
app.post('/createConnectedAccount', verifyFirebaseToken, async (req, res) => {
  try {
    const { businessId, email, country = 'US' } = req.body;

    const account = await stripe.accounts.create({
      type: 'express',
      country,
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      business_profile: {
        mcc: '7299', // Personal services (beauty, wellness, etc.)
        url: 'https://bookify.app',
      },
    });

    console.log(`✅ Created Stripe account ${account.id} for business ${businessId}`);
    res.json({ accountId: account.id });
  } catch (error) {
    console.error('Error creating connected account:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 2. Create Account Link for Onboarding
// ============================================================
app.post('/createAccountLink', verifyFirebaseToken, async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || returnUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (error) {
    console.error('Error creating account link:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 3. Retrieve Account Status
// ============================================================
app.post('/retrieveAccountStatus', verifyFirebaseToken, async (req, res) => {
  try {
    const { accountId } = req.body;
    const account = await stripe.accounts.retrieve(accountId);

    // Determine status: enabled means charges are fully active
    let status = 'pending';
    if (account.charges_enabled) {
      status = 'enabled';
    } else if (account.requirements?.currently_due?.length > 0) {
      status = 'restricted';
    }

    res.json({
      status,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
      capabilities: account.capabilities,
    });
  } catch (error) {
    console.error('Error retrieving account status:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 4. Create PaymentIntent DIRECTLY ON the business's Stripe account
//
//    KEY CHANGE from old code:
//    ❌ Old: stripe.paymentIntents.create({ transfer_data: { destination: bizAcctId } })
//            This charged your platform account and transferred — needs platform Stripe account.
//    ✅ New: stripe.paymentIntents.create(data, { stripeAccount: bizAcctId })
//            This creates the PaymentIntent ON the business's own account directly.
//            Money goes straight to them. No platform account needed.
// ============================================================
app.post('/createPaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, currency, businessStripeAccountId, bookingId } = req.body;

    if (!businessStripeAccountId) {
      return res.status(400).json({
        message: 'Business Stripe account ID is required. The business must complete Stripe onboarding first.',
      });
    }

    // Validate the connected account exists and can accept payments
    let connectedAccount;
    try {
      connectedAccount = await stripe.accounts.retrieve(businessStripeAccountId);
    } catch (err) {
      return res.status(400).json({
        message: 'Invalid business Stripe account. Please ask the business to reconnect their Stripe account.',
      });
    }

    if (!connectedAccount.charges_enabled) {
      return res.status(400).json({
        message: 'This business has not completed Stripe verification yet and cannot accept payments.',
        detailsSubmitted: connectedAccount.details_submitted,
        requirements: connectedAccount.requirements?.currently_due,
      });
    }

    // ✅ THE DIRECT PAYMENT APPROACH:
    // Pass { stripeAccount: businessStripeAccountId } as the second argument.
    // This makes Stripe create the PaymentIntent on the BUSINESS's own account.
    // The customer's money goes directly to the business — zero platform involvement.
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount), // must be integer (cents/paisa)
        currency: currency.toLowerCase(),
        payment_method_types: ['card'],
        metadata: {
          bookingId: bookingId || '',
          businessAccountId: businessStripeAccountId,
          createdBy: 'bookify_app',
        },
        // No transfer_data, no application_fee_amount — payment is direct
      },
      {
        // This header routes the API call to operate on the connected account
        stripeAccount: businessStripeAccountId,
      }
    );

    console.log(`✅ PaymentIntent ${paymentIntent.id} created on account ${businessStripeAccountId}`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      stripeAccountId: businessStripeAccountId, // Flutter needs this for the payment sheet
    });
  } catch (error) {
    console.error('Error creating PaymentIntent:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 5. Retrieve PaymentIntent (verify payment after completion)
//    Also needs stripeAccount header for direct account payments
// ============================================================
app.post('/retrievePaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const { paymentIntentId, businessStripeAccountId } = req.body;

    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      { stripeAccount: businessStripeAccountId } // required for direct payments
    );

    res.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      metadata: paymentIntent.metadata,
    });
  } catch (error) {
    console.error('Error retrieving PaymentIntent:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 6. Webhook — listens for account and payment updates
//    For direct payments, events fire on the CONNECTED account,
//    so you need to use the connected account's webhook secret.
// ============================================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const connectedAccountId = req.headers['stripe-account']; // present for Connect events

  switch (event.type) {
    case 'account.updated': {
      const account = event.data.object;
      console.log(`Account ${account.id} updated. Charges enabled: ${account.charges_enabled}`);
      // Optionally update Firestore stripeAccountStatus here
      break;
    }
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const bookingId = pi.metadata?.bookingId;
      console.log(`Payment succeeded for booking ${bookingId} on account ${connectedAccountId}`);
      // Optionally update booking paymentStatus to 'paid' in Firestore here
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.log(`Payment failed: ${pi.last_payment_error?.message}`);
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Stripe Direct Payment backend (no platform account)',
    mode: 'direct_to_connected_account',
    endpoints: [
      'POST /createConnectedAccount',
      'POST /createAccountLink',
      'POST /retrieveAccountStatus',
      'POST /createPaymentIntent  ← creates PaymentIntent on business own account',
      'POST /retrievePaymentIntent',
      'POST /webhook',
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Stripe Direct Payment backend running on port ${PORT}`);
});