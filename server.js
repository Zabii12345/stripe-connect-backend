require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK from Base64 environment variable
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

// Firebase Token Verification
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

// 1. Create Connected Account (Express) - ✅ FIXED: Dynamic country support
app.post('/createConnectedAccount', verifyFirebaseToken, async (req, res) => {
  try {
    const { businessId, email, country = 'PK' } = req.body; // ✅ Changed default to PK

    // ✅ Validate country is supported
    const supportedCountries = ['US', 'PK', 'GB', 'CA', 'AU', 'IN', 'AE'];
    if (!supportedCountries.includes(country)) {
      return res.status(400).json({
        message: `Unsupported country: ${country}. Supported: ${supportedCountries.join(', ')}`
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
    });
    console.log(`✅ Created Stripe account ${account.id} for business ${businessId} (${country})`);
    res.json({ accountId: account.id });
  } catch (error) {
    console.error('Error creating connected account:', error);
    res.status(500).json({ message: error.message });
  }
});

// 2. Create Account Link for Onboarding
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

// 3. Retrieve Account Status - ✅ FIXED: Returns real Stripe status (not custom status)
app.post('/retrieveAccountStatus', verifyFirebaseToken, async (req, res) => {
  try {
    const { accountId } = req.body;
    const account = await stripe.accounts.retrieve(accountId);

    // ✅ Return actual Stripe data - client determines status based on flags
    res.json({
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements,
      capabilities: account.capabilities,
      // ✅ Additional useful data
      country: account.country,
      email: account.email,
      businessType: account.business_type,
      // ✅ Compute proper status based on Stripe flags
      status: account.charges_enabled && account.payouts_enabled ? 'enabled'
              : (account.requirements?.currently_due?.length > 0 ? 'restricted' : 'pending'),
    });
  } catch (error) {
    console.error('Error retrieving account status:', error);
    res.status(500).json({ message: error.message });
  }
});

// 4. ✅ FIXED: Create PaymentIntent with proper Connect architecture
app.post('/createPaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const {
      amount,
      currency = 'usd',
      businessStripeAccountId,
      platformFee = 0,
      bookingId
    } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }

    if (!businessStripeAccountId) {
      return res.status(400).json({ message: 'Business Stripe account ID is required' });
    }

    // ✅ Verify account exists and can accept payments
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

    // ✅ Option A: Destination charges (recommended) - Payment goes to platform, then transfers to connected account
    // This is more reliable for onboarding verification
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(amount), // Ensure integer
        currency: currency.toLowerCase(),
        payment_method_types: ['card'],
        application_fee_amount: Math.round(platformFee),
        transfer_data: {
          destination: businessStripeAccountId,
        },
        metadata: {
          bookingId: bookingId || '',
          businessAccountId: businessStripeAccountId,
        },
      }
      // ✅ REMOVED stripeAccount param - using transfer_data instead (destination charge)
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      // ✅ Send account ID for reference
      stripeAccountId: businessStripeAccountId,
      // ✅ Send transfer info so client knows it's a destination charge
      isDestinationCharge: true,
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

// 5. Retrieve PaymentIntent (optional)
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

// 6. Webhook (optional)
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
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Stripe Connect backend running on port ${PORT}`);
});