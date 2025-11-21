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
        
        return `
${emoji} *Payment ${paymentStatus.toUpperCase()}*

*Reference:* ${transaction.reference}
*Amount:* ₦${transaction.amount}
*Email:* ${transaction.email}
*Name:* ${transaction.firstName || ''} ${transaction.lastName || ''}
*Phone:* ${transaction.phone || 'N/A'}
*Donation Type:* ${transaction.donationType || 'One-time'}

*Time:* ${watTime} (WAT)
`.trim();
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
