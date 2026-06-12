require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK (to verify Firebase ID tokens)
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID,
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Middleware
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
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// ============================================================
// 1. Create a Stripe Connect Account (Express or Standard)
// ============================================================
app.post('/createConnectedAccount', verifyFirebaseToken, async (req, res) => {
  try {
    const { businessId, email, country = 'US' } = req.body;

    // Create an Express account (simpler onboarding)
    const account = await stripe.accounts.create({
      type: 'express',
      country: country,
      email: email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual', // or 'company'
      business_profile: {
        mcc: '5734', // Computer software stores (change as needed)
        url: 'https://bookify.app',
      },
    });

    console.log(`✅ Created Stripe account ${account.id} for business ${businessId}`);

    // Store the account ID in Firestore (you can do this from your Flutter app or here)
    // We'll just return the accountId to the client
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

    res.json({
      status: account.charges_enabled ? 'enabled' : (account.requirements?.currently_due?.length > 0 ? 'restricted' : 'pending'),
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
// 4. Create PaymentIntent (for customer payment to connected account)
// ============================================================
app.post('/createPaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const { amount, currency, businessStripeAccountId, platformFee, bookingId } = req.body;

    // Create a PaymentIntent on the connected account
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amount, // already in cents/paisa
        currency: currency,
        payment_method_types: ['card'],
        transfer_data: {
          destination: businessStripeAccountId,
        },
        application_fee_amount: platformFee, // platform commission in cents
      },
      {
        stripeAccount: businessStripeAccountId,
      }
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error('Error creating PaymentIntent:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 5. Retrieve PaymentIntent (optional)
// ============================================================
app.get('/retrievePaymentIntent', verifyFirebaseToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.query;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    res.json({
      status: paymentIntent.status,
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
    });
  } catch (error) {
    console.error('Error retrieving PaymentIntent:', error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// 6. Webhook to listen for account updates (optional)
// ============================================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'account.updated':
      const account = event.data.object;
      console.log(`Account ${account.id} updated. Charges enabled: ${account.charges_enabled}`);
      // You can update Firestore here (e.g., set stripeAccountStatus)
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Stripe Connect backend running on port ${PORT}`);
});