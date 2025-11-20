// server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// Log status of key loading (Keep for debugging)
console.log('Loaded Secret Key:', process.env.PAYSTACK_SECRET_KEY ? 'Key Found' : 'Key Missing');
console.log('Loaded Frontend URL:', process.env.FRONTEND_URL ? process.env.FRONTEND_URL : 'MISSING');

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
app.use(express.json());

// 💡 FIX: Explicitly handle the OPTIONS preflight request.
// The Nginx proxy forwards the path as /payments/initialize to Express.
app.options('/payments/initialize', (req, res) => {
    // The 'cors' middleware has already run and set the necessary headers.
    // We just need to send a 200 OK status.
    res.sendStatus(200);
});
// ------------------------------------------------------------


function logTransactionStorage(transaction) {
    console.log('--- DB ACTION: Logged new PENDING transaction ---');
    console.log('Reference:', transaction.reference, 'Amount:', transaction.amount, 'Email:', transaction.email);
}

function logTransactionUpdate(reference, updates) {
    console.log('--- DB ACTION: Logged transaction update ---');
    console.log('Reference:', reference, 'Updates:', updates);
}

// --- Routes ---
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
        const reference = `OBAMA_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

        // 4. Initialize payment with Paystack using direct API call
        const paymentData = {
            amount: amount * 100, // Convert to kobo
            email: email,
            reference: reference,
            currency: 'NGN',
            callback_url: `${process.env.FRONTEND_URL}/payment-callback`,
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
                timeout: 10000 // 10 second timeout
            }
        );

        console.log('--- Paystack API Response ---');
        console.log('Status:', paystackResponse.status);
        console.log('Data:', paystackResponse.data);
        console.log('------------------------------');

        // Check if Paystack API call was successful
        if (paystackResponse.data.status === true) {
            // 5. Log transaction storage
            logTransactionStorage({
                reference: reference,
                amount: amount,
                email: email,
                status: 'pending',
                metadata: fullMetadata
            });

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

// Verification endpoint using direct API approach
app.get('/payments/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        console.log('--- Verifying Payment ---');
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

        if (verificationResponse.data.status && verificationResponse.data.data.status === 'success') {
            // Log transaction update
            logTransactionUpdate(reference, {
                status: 'success (VERIFIED)',
                verifiedAt: new Date(),
                paymentData: verificationResponse.data.data
            });

            res.json({
                success: true,
                message: 'Payment verified successfully',
                data: verificationResponse.data.data
            });
        } else {
            // Log transaction update
            logTransactionUpdate(reference, {
                status: verificationResponse.data.data?.status || 'failed (VERIFIED)',
                verifiedAt: new Date()
            });

            res.status(400).json({
                success: false,
                message: 'Payment verification failed',
                data: verificationResponse.data.data
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
        timestamp: new Date().toISOString()
    });
});

// Root endpoint (Updated to reflect no /api/ prefix in Express)
app.get('/', (req, res) => {
    res.json({
        message: 'Paystack Payment Server',
        version: '1.0.0',
        endpoints: {
            initialize: 'POST /payments/initialize',
            verify: 'GET /payments/verify/:reference',
            health: 'GET /health'
        }
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
