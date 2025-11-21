const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// Import modules
const database = require('./db/database');
const notificationService = require('./notifications/notificationService');

// Log status of key loading (Keep for debugging)
//console.log('Loaded Secret Key:', process.env.PAYSTACK_SECRET_KEY ? 'Key Found' : 'Key Missing');

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
      'https://royalscholars.thekingstutor.com', // Explicitly add this
      'https://royalscholars.thekingstutor.com/' // With trailing slash
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

app.options('/payments/initialize', (req, res) => {
  res.sendStatus(200);
});

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

    const transactionData = verificationResponse.data.data;
    const paymentStatus = transactionData.status;

    if (verificationResponse.data.status && paymentStatus === 'success') {
      // Update transaction in database
      await database.updateTransaction(reference, {
        status: 'completed',
        verified_at: new Date().toISOString()
      });

      // Get full transaction details for notification
      const transaction = await database.getTransaction(reference);
      
      // Notify admin about completed payment
      if (transaction) {
        await notificationService.notifyAdmin(transaction, 'completed');
      }

      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: transactionData
      });
    } else {
      // Update transaction status based on Paystack response
      const statusMap = {
        'failed': 'failed',
        'abandoned': 'abandoned',
        'pending': 'pending'
      };

      const updateStatus = statusMap[paymentStatus] || 'failed';
      
      await database.updateTransaction(reference, {
        status: updateStatus
      });

      // Get transaction for notification
      const transaction = await database.getTransaction(reference);
      if (transaction) {
        await notificationService.notifyAdmin(transaction, updateStatus);
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
    database: 'Connected'
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
