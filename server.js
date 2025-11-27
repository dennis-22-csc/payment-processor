const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// Import modules
const database = require('./db/database');
const notificationService = require('./notifications/notificationService');

// Log status of key loading
console.log('Loaded Secret Key:', process.env.PAYSTACK_SECRET_KEY ? 'Key Found' : 'Key Missing');
console.log('Loaded Frontend URL:', process.env.FRONTEND_URL ? process.env.FRONTEND_URL : 'MISSING');
console.log('Loaded Backend URL:', process.env.BACKEND_URL ? process.env.BACKEND_URL : 'MISSING');

const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://localhost:8000',
            'http://127.0.0.1:8000',
            'http://0.0.0.0:8000',
            process.env.FRONTEND_URL
        ].filter(Boolean);

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

// Middleware to parse JSON for all routes EXCEPT the webhook
app.use((req, res, next) => {
    if (req.originalUrl === '/payments/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.options('/payments/initialize', (req, res) => {
    res.sendStatus(200);
});

// --- Routes ---

// 1. PAYMENT INITIALIZATION
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

        // 3. Construct the full metadata object with USD amount
        const fullMetadata = {
            custom_fields: [
                {
                    display_name: "First Name",
                    variable_name: "first_name",
                    value: firstName || ''
                },
                {
                    display_name: "Last Name",
                    variable_name: "last_name",
                    value: lastName || ''
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
                },
                {
                    display_name: "Original Amount USD",
                    variable_name: "original_amount_usd",
                    value: metadata?.originalAmountUSD || 0
                }
            ],
            // Store USD amount at the root level too for easy access
            originalAmountUSD: metadata?.originalAmountUSD || 0,
            ...metadata
        };

        // 4. Initialize payment with Paystack
        const paymentData = {
            amount: amount * 100, // Convert to kobo
            email: email,
            reference: reference,
            currency: 'NGN',
            callback_url: `${process.env.FRONTEND_URL}`, 
            metadata: JSON.stringify(fullMetadata)
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
                timeout: 10000
            }
        );

        console.log('--- Paystack API Response ---');
        console.log('Status:', paystackResponse.status);
        console.log('Data:', paystackResponse.data);
        console.log('------------------------------');

        // Check if Paystack API call was successful
        if (paystackResponse.data.status === true) {
            // 5. Store transaction in database - names go in dedicated columns, USD in metadata
            const transactionData = {
                reference: reference,
                amount: amount,
                email: email,
                firstName: firstName || '',
                lastName: lastName || '',
                phone: phone || '',
                donationType: frequency,
                metadata: fullMetadata, // This includes originalAmountUSD
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

// 2. WEBHOOK LISTENER
app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const hash = crypto.createHmac('sha512', secret).update(req.body).digest('hex');
    const paystackSignature = req.headers['x-paystack-signature'];

    if (hash !== paystackSignature) {
        console.error('Webhook signature failed verification!');
        return res.status(401).send('Invalid Signature');
    }

    const event = JSON.parse(req.body.toString());
    const eventData = event.data;
    const reference = eventData.reference;

    console.log('--- Paystack Webhook Received ---');
    console.log('Event Type:', event.event);
    console.log('Reference:', reference);
    console.log('---------------------------------');

    try {
        if (event.event === 'charge.success') {
            // Check if we've already processed this transaction
            const currentTransaction = await database.getTransaction(reference);
            if (currentTransaction && currentTransaction.status === 'completed') {
                console.log(`Transaction ${reference} already completed. Ignoring webhook.`);
                return res.sendStatus(200);
            }

            if (eventData.status === 'success') {
                // Extract name and USD amount from webhook metadata
                let firstName = '';
                let lastName = '';
                let originalAmountUSD = 0;

                // Try to get name from webhook metadata first
                if (eventData.metadata) {
                    let metadata;
                    try {
                        // Handle both string and object metadata
                        metadata = typeof eventData.metadata === 'string' 
                            ? JSON.parse(eventData.metadata) 
                            : eventData.metadata;
                        
                        if (metadata.custom_fields) {
                            const customFields = metadata.custom_fields;
                            const firstNameField = customFields.find(field => field.variable_name === 'first_name');
                            const lastNameField = customFields.find(field => field.variable_name === 'last_name');
                            const usdAmountField = customFields.find(field => field.variable_name === 'original_amount_usd');
                            
                            firstName = firstNameField?.value || '';
                            lastName = lastNameField?.value || '';
                            originalAmountUSD = usdAmountField?.value || 0;
                        }
                        
                        // Also check direct metadata properties
                        if (!originalAmountUSD && metadata.originalAmountUSD) {
                            originalAmountUSD = metadata.originalAmountUSD;
                        }
                    } catch (parseError) {
                        console.error('Error parsing metadata:', parseError.message);
                    }
                }

                // If names not found in webhook, use existing transaction data
                if ((!firstName && !lastName) && currentTransaction) {
                    firstName = currentTransaction.first_name || '';
                    lastName = currentTransaction.last_name || '';
                }

                // If USD amount not found, try to get from existing transaction metadata
                if (!originalAmountUSD && currentTransaction && currentTransaction.metadata) {
                    try {
                        const existingMetadata = typeof currentTransaction.metadata === 'string' 
                            ? JSON.parse(currentTransaction.metadata) 
                            : currentTransaction.metadata;
                        originalAmountUSD = existingMetadata.originalAmountUSD || 0;
                    } catch (e) {
                        console.error('Error parsing existing metadata:', e.message);
                    }
                }

                // Prepare metadata with USD amount for storage
                let updatedMetadata = {};
                if (currentTransaction && currentTransaction.metadata) {
                    try {
                        updatedMetadata = typeof currentTransaction.metadata === 'string' 
                            ? JSON.parse(currentTransaction.metadata) 
                            : currentTransaction.metadata;
                    } catch (e) {
                        console.error('Error parsing current metadata:', e.message);
                    }
                }
                
                // Ensure USD amount is preserved in metadata
                updatedMetadata.originalAmountUSD = originalAmountUSD;

                // Update transaction
                await database.updateTransaction(reference, {
                    status: 'completed',
                    verified_at: new Date().toISOString(),
                    metadata: JSON.stringify(updatedMetadata)
                });

                // Get full transaction details for notification
                const transaction = await database.getTransaction(reference);

                // Notify admin about completed payment with all details
                if (transaction) {
                    await notificationService.notifyAdmin(transaction, 'completed (via Webhook)');
                }
            } else {
                 console.log(`Charge not successful. Status: ${eventData.status}`);
                 await database.updateTransaction(reference, { status: eventData.status });
            }

        } else if (event.event === 'transfer.success') {
            console.log(`Transfer successful: ${reference}`);
        }

        res.sendStatus(200);

    } catch (dbError) {
        console.error('Database error during webhook processing:', dbError.message);
        res.status(500).send('Server Error Processing Webhook');
    }
});

// 3. VERIFICATION ENDPOINT
app.get('/payments/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        console.log('--- Verifying Payment (Callback Flow) ---');
        console.log('Reference:', reference);
        console.log('------------------------------');

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

        const currentTransaction = await database.getTransaction(reference);
        const dbStatus = currentTransaction ? currentTransaction.status : 'not_found';
        
        if (verificationResponse.data.status && paymentStatus === 'success' && dbStatus !== 'completed') {
            // Extract name and USD amount from verification response metadata
            let firstName = '';
            let lastName = '';
            let originalAmountUSD = 0;

            if (transactionData.metadata) {
                let metadata;
                try {
                    metadata = typeof transactionData.metadata === 'string' 
                        ? JSON.parse(transactionData.metadata) 
                        : transactionData.metadata;
                    
                    if (metadata.custom_fields) {
                        const customFields = metadata.custom_fields;
                        const firstNameField = customFields.find(field => field.variable_name === 'first_name');
                        const lastNameField = customFields.find(field => field.variable_name === 'last_name');
                        const usdAmountField = customFields.find(field => field.variable_name === 'original_amount_usd');
                        
                        firstName = firstNameField?.value || '';
                        lastName = lastNameField?.value || '';
                        originalAmountUSD = usdAmountField?.value || 0;
                    }
                    
                    if (!originalAmountUSD && metadata.originalAmountUSD) {
                        originalAmountUSD = metadata.originalAmountUSD;
                    }
                } catch (parseError) {
                    console.error('Error parsing metadata in verification:', parseError.message);
                }
            }

            // Prepare metadata with USD amount for storage
            let updatedMetadata = {};
            if (currentTransaction && currentTransaction.metadata) {
                try {
                    updatedMetadata = typeof currentTransaction.metadata === 'string' 
                        ? JSON.parse(currentTransaction.metadata) 
                        : currentTransaction.metadata;
                } catch (e) {
                    console.error('Error parsing current metadata in verification:', e.message);
                }
            }
            
            // Ensure USD amount is preserved in metadata
            updatedMetadata.originalAmountUSD = originalAmountUSD;

            await database.updateTransaction(reference, {
                status: 'completed',
                verified_at: new Date().toISOString(),
                metadata: JSON.stringify(updatedMetadata)
            });

            const transaction = await database.getTransaction(reference);
            
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
             res.json({
                success: true,
                message: 'Payment verified and already completed by webhook',
                data: transactionData,
                dbStatus: 'completed_by_webhook'
            });
        } 
        else {
            const statusMap = {
                'failed': 'failed',
                'abandoned': 'abandoned',
                'pending': 'pending'
            };

            const updateStatus = statusMap[paymentStatus] || 'failed';
            
            if (dbStatus !== updateStatus) {
                await database.updateTransaction(reference, {
                    status: updateStatus
                });
            }

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
            webhook: 'POST /payments/webhook',
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
