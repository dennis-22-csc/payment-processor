const axios = require('axios');

class NotificationService {
    constructor() {
        this.adminPhone = process.env.ADMIN_PHONE;
        this.whatsappSenderUrl = "http://localhost:3001/send-whatsapp-message";
    }

    async notifyAdmin(transaction, paymentStatus) {
        try {
            const message = this.formatNotificationMessage(transaction, paymentStatus);
            
            // Send WhatsApp notification to admin
            if (this.adminPhone) {
                await this.sendWhatsAppNotification(this.adminPhone, message);
            }
            
            console.log(`Admin notified about transaction ${transaction.reference}`);
            return true;
        } catch (error) {
            console.error('Error notifying admin:', error.message);
            return false;
        }
    }

    formatNotificationMessage(transaction, paymentStatus) {
        const statusEmoji = {
            'initiated': '🟡',
            'pending': '🟡', 
            'completed': '🟢',
            'success': '🟢',
            'failed': '🔴',
            'abandoned': '⚫'
        };
        
        const emoji = statusEmoji[paymentStatus] || '⚪';
        
        const watTime = new Date().toLocaleString('en-US', {
            timeZone: 'Africa/Lagos',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        // Extract name from transaction - handle both object properties and database fields
        const firstName = transaction.first_name || transaction.firstName || '';
        const lastName = transaction.last_name || transaction.lastName || '';
        const fullName = `${firstName} ${lastName}`.trim();
        
        // Extract USD amount from metadata
        let originalAmountUSD = 0;
        if (transaction.metadata) {
            try {
                const metadata = typeof transaction.metadata === 'string' 
                    ? JSON.parse(transaction.metadata) 
                    : transaction.metadata;
                originalAmountUSD = metadata.originalAmountUSD || 0;
            } catch (e) {
                console.error('Error parsing metadata for notification:', e.message);
            }
        }

        // Format the message with proper line breaks and bold formatting
        let message = `
${emoji} *Payment ${paymentStatus.toUpperCase()}*

*Reference:* ${transaction.reference}
*Amount:* ₦${transaction.amount}`;

        // Add USD amount if available - on the same line as NGN amount
        if (originalAmountUSD > 0) {
            message += ` ($${originalAmountUSD})`;
        }

        // Continue with proper line breaks for other fields
        message += `
*Email:* ${transaction.email}
*Name:* ${fullName || 'N/A'}
*Phone:* ${transaction.phone || 'N/A'}
*Donation Type:* ${transaction.donation_type || transaction.donationType || 'One-time'}

*Time:* ${watTime} (WAT)`;

        return message.trim();
    }

    async sendWhatsAppNotification(phoneNumber, message) {
        try {
            const payload = {
                phone_number: phoneNumber,
                message: message,
                is_admin_notification: true
            };
            
            const response = await axios.post(this.whatsappSenderUrl, payload, {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 200) {
                console.log(`WhatsApp notification sent successfully to admin`);
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Failed to send WhatsApp notification to admin:', error.message);
            return false;
        }
    }
}

module.exports = new NotificationService();
