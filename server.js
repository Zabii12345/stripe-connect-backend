require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// Firebase Admin SDK
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!serviceAccountBase64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable is missing');
  process.exit(1);
}
const serviceAccountJson = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// ---- Fee configuration ----
const PLATFORM_FEE_PERCENTAGE = parseFloat(process.env.PLATFORM_FEE_PERCENTAGE) || 0.0;
const INCLUDE_STRIPE_FEE = process.env.INCLUDE_STRIPE_FEE !== 'false';
const STRIPE_FEE_PERCENTAGE = 0.029;
const STRIPE_FEE_FIXED_CENTS = 30; // $0.30 in cents
const MINIMUM_CENTS = 50; // $0.50 minimum for US cards

console.log(`⚙️  Platform fee percentage: ${PLATFORM_FEE_PERCENTAGE * 100}%`);
console.log(`⚙️  Include Stripe fee: ${INCLUDE_STRIPE_FEE}`);

// ---- Middleware ----
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ---- Endpoints ----

// 1. Create Connected Account
app.post('/createConnectedAccount', verifyFirebaseToken, async (req, res) => {
  try {
    const { businessId, email, country = 'US' } = req.body;
    const supportedCountries = ['US', 'GB', 'CA', 'AU', 'IE', 'NL', 'ES', 'IT', 'FR', 'DE'];
    if (!supportedCountries.includes(country)) {
      return res.status(400).json({
        message: `Country ${country} does not support card payments directly. Please use US, UK, CA, AU, or EU countries.`,
        supported: supportedCountries
      });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      country: country,
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      business_profile: {
        mcc: '5734',
        url: 'https://bookify.app',
      },
      ...(country !== 'US' && {
        settings: {
          payouts: {
            schedule: {
              interval: 'manual',
            },
          },
        },
      }),
    });
    console.log(`✅ Created Stripe account ${account.id} for business ${businessId} (${country})`);
    res.json({ accountId: account.id });
  } catch (error) {
    console.error('Error creating connected account:', error);
    res.status(500).json({ message: error.message });
  }
});

// 2. Create Account Link
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

// 3. Retrieve Account Status
app.post('/retrieveAccountStatus', verifyFirebaseToken, async (req, res) => {
  try {
    const { accountId } = req.body;
    const account = await stripe.accounts.retrieve(accountId);
    res.json({
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
      capabilities: account.capabilities,
      country: account.country,
      email: account.email,
      businessType: account.business_type,
      status: account.charges_enabled && account.payouts_enabled ? 'enabled'
              : (account.requirements?.currently_due?.length > 0 ? 'restricted' : 'pending'),
    });
  } catch (error) {
    console.error('Error retrieving account status:', error);
    res.status(500).json({ message: error.message });
  }
});

// 4. Create PaymentIntent (UPDATED with fee calculation)
app.post('/createPaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const {
      amount,                     // in cents, treated as desired net amount
      currency = 'usd',
      businessStripeAccountId,
      platformFee = 0,            // optional override
      bookingId
    } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    if (!businessStripeAccountId) {
      return res.status(400).json({ message: 'Business Stripe account ID is required' });
    }

    // Verify account
    try {
      const account = await stripe.accounts.retrieve(businessStripeAccountId);
      if (!account.charges_enabled) {
        return res.status(400).json({
          message: 'Business Stripe account is not yet ready to accept payments. Please complete Stripe onboarding.',
          chargesEnabled: false,
          requirements: account.requirements,
        });
      }
    } catch (accountError) {
      console.error('Error retrieving account:', accountError);
      return res.status(400).json({
        message: 'Invalid or not found Stripe account. Please reconnect your Stripe account.'
      });
    }

    // ---- Fee calculation ----
    const desiredAmountCents = amount; // already in cents

    // 1. Platform fee (if any)
    let platformFeeCents = Math.round(desiredAmountCents * PLATFORM_FEE_PERCENTAGE);
    if (platformFee > 0) {
      platformFeeCents = Math.round(platformFee);
    }

    // 2. Total to charge
    let totalCents = desiredAmountCents + platformFeeCents;

    // 3. Include Stripe processing fee (2.9% + $0.30) on top
    if (INCLUDE_STRIPE_FEE) {
      const numerator = desiredAmountCents + platformFeeCents + STRIPE_FEE_FIXED_CENTS;
      totalCents = Math.round(numerator / (1 - STRIPE_FEE_PERCENTAGE));
    }

    // Ensure minimum
    if (totalCents < MINIMUM_CENTS) {
      return res.status(400).json({
        message: `Total amount must be at least $${(MINIMUM_CENTS / 100).toFixed(2)} USD. Your desired net amount is too low.`
      });
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: currency.toLowerCase(),
        payment_method_types: ['card'],
        application_fee_amount: platformFeeCents,
        transfer_data: {
          destination: businessStripeAccountId,
        },
        metadata: {
          bookingId: bookingId || '',
          businessAccountId: businessStripeAccountId,
          desiredNetAmount: desiredAmountCents.toString(),
          platformFee: platformFeeCents.toString(),
          includeStripeFee: INCLUDE_STRIPE_FEE ? 'true' : 'false',
        },
      }
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      stripeAccountId: businessStripeAccountId,
      isDestinationCharge: true,
      // Optional breakdown for debugging
      breakdown: {
        desiredNet: desiredAmountCents / 100,
        platformFee: platformFeeCents / 100,
        stripeFee: (totalCents - desiredAmountCents - platformFeeCents) / 100,
        total: totalCents / 100,
      },
    });
  } catch (error) {
    console.error('Error creating PaymentIntent:', error);
    res.status(500).json({
      message: error.message,
      type: error.type,
      code: error.code,
    });
  }
});

// 5. Retrieve PaymentIntent
app.get('/retrievePaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.query;
    if (!paymentIntentId) {
      return res.status(400).json({ message: 'paymentIntentId is required' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    res.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      transferId: paymentIntent.transfer,
      applicationFeeAmount: paymentIntent.application_fee_amount,
    });
  } catch (error) {
    console.error('Error retrieving PaymentIntent:', error);
    res.status(500).json({ message: error.message });
  }
});

// 6. Webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  switch (event.type) {
    case 'account.updated':
      const account = event.data.object;
      console.log(`Account ${account.id} updated. Charges enabled: ${account.charges_enabled}`);
      break;
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log(`PaymentIntent ${paymentIntent.id} succeeded`);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  res.json({ received: true });
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Stripe Connect backend is running',
    endpoints: [
      'POST /createConnectedAccount',
      'POST /createAccountLink',
      'POST /retrieveAccountStatus',
      'POST /createPaymentIntent',
      'GET /retrievePaymentIntent',
      'POST /webhook'
    ],
    config: {
      platformFeePercentage: PLATFORM_FEE_PERCENTAGE * 100 + '%',
      includeStripeFee: INCLUDE_STRIPE_FEE,
      stripeFeePercentage: STRIPE_FEE_PERCENTAGE * 100 + '%',
      stripeFeeFixed: '$' + (STRIPE_FEE_FIXED_CENTS / 100).toFixed(2),
      minimumAmount: '$' + (MINIMUM_CENTS / 100).toFixed(2),
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Stripe Connect backend running on port ${PORT}`);
});