const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); // Built-in Node.js module for security checks
require('dotenv').config();

// Import modules
const database = require('./db/database');
const notificationService = require('./notifications/notificationService');

// Log status of key loading (Keep for debugging)
console.log('Loaded Secret Key:', process.env.PAYSTACK_SECRET_KEY ? 'Key Found' : 'Key Missing');
console.log('Loaded Frontend URL:', process.env.FRONTEND_URL ? process.env.FRONTEND_URL : 'MISSING');
console.log('Loaded Backend URL:', process.env.BACKEND_URL ? process.env.BACKEND_URL : 'MISSING');

const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, or file://)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://localhost:8000',
            'http://127.0.0.1:8000',
            'http://0.0.0.0:8000',
            process.env.FRONTEND_URL
        ].filter(Boolean); // Remove any undefined values

        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('CORS blocked for origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Middleware
app.use(cors(corsOptions));

// ⚠️ IMPORTANT: For webhooks, you need a different body parser setup.
// We'll use express.json() for all *other* routes, but use raw body for the webhook.

// Middleware to parse JSON for all routes EXCEPT the webhook
app.use((req, res, next) => {
    if (req.originalUrl === '/payments/webhook') {
        next(); // Skip JSON parsing for webhook route
    } else {
        express.json()(req, res, next);
    }
});

app.options('/payments/initialize', (req, res) => {
    res.sendStatus(200);
});

// --- Routes ---

// 1. PAYMENT INITIALIZATION (Callback URL Logic is set here)
// The Paystack endpoint to start a payment
app.post('/payments/initialize', async (req, res) => {
    try {
        console.log('--- Frontend Payload Received ---');
        console.log(req.body);
        console.log('-----------------------------------');

        const { amount, email, firstName, lastName, phone, frequency, metadata } = req.body;

        // 1. Validate required fields
        if (!amount || !email) {
            return res.status(400).json({
                success: false,
                message: 'Amount and email are required'
            });
        }

        // 2. Create transaction reference
        const reference = `ROYAL_SCHOLARS_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // 3. Construct the full metadata object
        const fullMetadata = {
            custom_fields: [
                {
                    display_name: "First Name",
                    variable_name: "first_name",
                    value: firstName
                },
                {
                    display_name: "Last Name",
                    variable_name: "last_name",
                    value: lastName
                },
                {
                    display_name: "Phone",
                    variable_name: "phone",
                    value: phone || ''
                },
                {
                    display_name: "Donation Type",
                    variable_name: "donation_type",
                    value: frequency
                }
            ],
            ...metadata
        };

        // 4. Initialize payment with Paystack
        const paymentData = {
            amount: amount * 100, // Convert to kobo
            email: email,
            reference: reference,
            currency: 'NGN',
            // 💡 CALLBACK URL: Where Paystack redirects the USER (browser)
            callback_url: `${process.env.FRONTEND_URL}/payment-callback`, 
            metadata: JSON.stringify(fullMetadata)
            // Note: Paystack webhooks are configured globally on the dashboard,
            // but for security, some developers prefer to use the channel metadata 
            // for the webhook URL to pass it on initialization. Paystack does 
            // not support setting the primary webhook URL via the initialize API call.
        };

        console.log('--- Final Paystack Payload ---');
        console.log({
            ...paymentData,
            metadata: JSON.parse(paymentData.metadata)
        });
        console.log('------------------------------');

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            paymentData,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000 // 10 second timeout
            }
        );

        console.log('--- Paystack API Response ---');
        console.log('Status:', paystackResponse.status);
        console.log('Data:', paystackResponse.data);
        console.log('------------------------------');

        // Check if Paystack API call was successful
        if (paystackResponse.data.status === true) {
            // 5. Store transaction in database
            const transactionData = {
                reference: reference,
                amount: amount,
                email: email,
                firstName: firstName,
                lastName: lastName,
                phone: phone,
                donationType: frequency,
                metadata: fullMetadata,
                status: 'initiated'
            };

            await database.logTransaction(transactionData);

            // 6. Notify admin about initiated payment
            await notificationService.notifyAdmin(transactionData, 'initiated');

            res.json({
                success: true,
                message: 'Payment initialized successfully',
                data: paystackResponse.data.data
            });
        } else {
            // Paystack returned an error in the response
            const errorMessage = paystackResponse.data.message || 'Paystack initialization failed';
            console.error('Paystack API Error Response:', errorMessage);

            res.status(400).json({
                success: false,
                message: errorMessage,
                error: paystackResponse.data
            });
        }

    } catch (error) {
        console.error('Payment initialization error:', error.message);

        // Handle different types of errors
        if (error.response) {
            // Paystack API returned an error response (4xx, 5xx)
            console.error('Paystack API Error:', error.response.data);
            res.status(error.response.status || 500).json({
                success: false,
                message: error.response.data?.message || 'Paystack API error',
                error: error.response.data
            });
        } else if (error.request) {
            // Request was made but no response received
            console.error('No response received from Paystack');
            res.status(503).json({
                success: false,
                message: 'Payment service temporarily unavailable',
                error: 'No response from payment provider'
            });
        } else {
            // Something else went wrong
            res.status(500).json({
                success: false,
                message: 'Failed to initialize payment',
                error: error.message
            });
        }
    }
});

// 2. WEBHOOK LISTENER (The RELIABLE Server-to-Server method)
// ⚠️ Set this endpoint as your Webhook URL in your Paystack Dashboard settings.
app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    // 1. Verify the signature for security
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
    const paystackSignature = req.headers['x-paystack-signature'];

    if (hash !== paystackSignature) {
        // Reject the request if the signature is invalid
        console.error('Webhook signature failed verification!');
        return res.status(401).send('Invalid Signature');
    }

    // 2. Parse the body now that it's authenticated
    const event = JSON.parse(req.body.toString());
    const eventData = event.data;
    const reference = eventData.reference;

    console.log('--- Paystack Webhook Received ---');
    console.log('Event Type:', event.event);
    console.log('Reference:', reference);
    console.log('---------------------------------');

    try {
        if (event.event === 'charge.success') {
            // 3. Optional: Verify the transaction again using Paystack API (Best Practice)
            // You should still verify in a live environment to prevent fraud/manipulation
            // However, for simplicity and acknowledging a reliable webhook, we can update directly.
            // NOTE: The `eventData` here is already verified by Paystack before sending.

            // 4. Check if we've already processed this transaction (Idempotency)
            const currentTransaction = await database.getTransaction(reference);
            if (currentTransaction && currentTransaction.status === 'completed') {
                console.log(`Transaction ${reference} already completed. Ignoring webhook.`);
                // Send 200 OK anyway so Paystack stops retrying
                return res.sendStatus(200);
            }

            if (eventData.status === 'success') {
                // 5. Update transaction and fulfill service/product
                await database.updateTransaction(reference, {
                    status: 'completed',
                    verified_at: new Date().toISOString()
                });

                // Get full transaction details for notification
                const transaction = await database.getTransaction(reference);

                // 6. Notify admin about completed payment (THE RELIABLE FULFILLMENT POINT)
                if (transaction) {
                    await notificationService.notifyAdmin(transaction, 'completed (via Webhook)');
                }
                
                // You would typically handle sending the user's order confirmation email/SMS here
            } else {
                 // Handle other non-success charge states if necessary
                 console.log(`Charge not successful. Status: ${eventData.status}`);
                 await database.updateTransaction(reference, { status: eventData.status });
            }

        } else if (event.event === 'transfer.success') {
            // Handle transfer status updates
            console.log(`Transfer successful: ${reference}`);
        }
        // ... handle other important events like 'subscription.create', 'invoice.update', etc.

        // 7. Acknowledge receipt to Paystack
        res.sendStatus(200);

    } catch (dbError) {
        console.error('Database error during webhook processing:', dbError.message);
        // Do NOT send a 200 OK. Paystack will retry if we fail.
        res.status(500).send('Server Error Processing Webhook');
    }
});


// 3. VERIFICATION ENDPOINT (Callback URL method - Frontend calls this)
// Frontend redirects with reference, then calls this endpoint to verify
app.get('/payments/verify/:reference', async (req, res) => {
    // This logic is mostly for the Callback URL flow where the frontend needs to confirm status.
    // In a production environment, this primarily provides the final status to the frontend.
    // The Webhook is the source of truth for value fulfillment.
    try {
        const { reference } = req.params;

        console.log('--- Verifying Payment (Callback Flow) ---');
        console.log('Reference:', reference);
        console.log('------------------------------');

        // Verify payment with Paystack using direct API call
        const verificationResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        console.log('--- Paystack Verification Response ---');
        console.log('Status:', verificationResponse.status);
        console.log('Data:', verificationResponse.data);
        console.log('------------------------------');

        const transactionData = verificationResponse.data.data;
        const paymentStatus = transactionData.status;

        // Retrieve the transaction from your DB to check its status (which Webhook may have already updated)
        const currentTransaction = await database.getTransaction(reference);
        const dbStatus = currentTransaction ? currentTransaction.status : 'not_found';
        
        // Only update the DB if the webhook hasn't done so, OR if the status is better.
        if (verificationResponse.data.status && paymentStatus === 'success' && dbStatus !== 'completed') {
            // Update transaction in database
            await database.updateTransaction(reference, {
                status: 'completed',
                verified_at: new Date().toISOString()
            });

            // Re-fetch the updated transaction for notification
            const transaction = await database.getTransaction(reference);
            
            // Notify admin about completed payment (as a fallback/confirmation)
            if (transaction) {
                await notificationService.notifyAdmin(transaction, 'completed (via Verification)');
            }

            res.json({
                success: true,
                message: 'Payment verified successfully',
                data: transactionData,
                dbStatus: 'updated_via_verification'
            });
        } else if (dbStatus === 'completed') {
             // Webhook already processed it - this is the ideal state
             res.json({
                success: true,
                message: 'Payment verified and already completed by webhook',
                data: transactionData,
                dbStatus: 'completed_by_webhook'
            });
        } 
        else {
            // Update transaction status based on Paystack response (e.g., failed, abandoned)
            const statusMap = {
                'failed': 'failed',
                'abandoned': 'abandoned',
                'pending': 'pending'
            };

            const updateStatus = statusMap[paymentStatus] || 'failed';
            
            if (dbStatus !== updateStatus) { // Prevent unnecessary updates
                await database.updateTransaction(reference, {
                    status: updateStatus
                });
            }

            // Get transaction for notification
            const transaction = await database.getTransaction(reference);
            if (transaction && transaction.status === updateStatus) {
                await notificationService.notifyAdmin(transaction, updateStatus + ' (via Verification)');
            }

            res.status(400).json({
                success: false,
                message: `Payment ${updateStatus}`,
                data: transactionData
            });
        }

    } catch (error) {
        console.error('Payment verification error:', error.message);

        if (error.response) {
            // Paystack API returned an error response
            res.status(error.response.status || 500).json({
                success: false,
                message: error.response.data?.message || 'Payment verification failed',
                error: error.response.data
            });
        } else if (error.request) {
            // Request was made but no response received
            res.status(503).json({
                success: false,
                message: 'Payment service temporarily unavailable',
                error: 'No response from payment provider'
            });
        } else {
            // Something else went wrong
            res.status(500).json({
                success: false,
                message: 'Payment verification failed',
                error: error.message
            });
        }
    }
});


// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        database: 'Connected',
        webhook_listener: 'POST /payments/webhook'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Paystack Payment Server',
        version: '1.0.0',
        endpoints: {
            initialize: 'POST /payments/initialize',
            verify: 'GET /payments/verify/:reference',
            webhook: 'POST /payments/webhook', // Highlight the new endpoint
            health: 'GET /health',
        }
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    database.close();
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
