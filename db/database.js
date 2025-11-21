const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
    constructor() {
        // Database file path outside project directory
        const dbDir = '/home/dennis/data/payment_processor/';
        const dbFile = path.join(dbDir, 'payments.db');
        
        // Ensure directory exists
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        this.db = new sqlite3.Database(dbFile, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
            } else {
                console.log('Connected to SQLite database:', dbFile);
                this.initTables();
            }
        });
    }

    initTables() {
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                reference TEXT UNIQUE NOT NULL,
                amount REAL NOT NULL,
                email TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                first_name TEXT,
                last_name TEXT,
                phone TEXT,
                donation_type TEXT,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                verified_at DATETIME
            )
        `;
        
        this.db.run(createTableSQL, (err) => {
            if (err) {
                console.error('Error creating table:', err.message);
            } else {
                console.log('Transactions table ready');
            }
        });
    }

    async logTransaction(transaction) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO transactions 
                (reference, amount, email, status, first_name, last_name, phone, donation_type, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            
            const params = [
                transaction.reference,
                transaction.amount,
                transaction.email,
                transaction.status || 'pending',
                transaction.firstName,
                transaction.lastName,
                transaction.phone,
                transaction.donationType,
                JSON.stringify(transaction.metadata || {})
            ];
            
            this.db.run(sql, params, function(err) {
                if (err) {
                    console.error('Error logging transaction:', err.message);
                    reject(err);
                } else {
                    console.log('--- DB ACTION: Logged new transaction ---');
                    console.log('Reference:', transaction.reference, 'Amount:', transaction.amount, 'Email:', transaction.email);
                    resolve(this.lastID);
                }
            });
        });
    }

    async updateTransaction(reference, updates) {
        return new Promise((resolve, reject) => {
            const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
            const sql = `
                UPDATE transactions 
                SET ${setClause}, updated_at = CURRENT_TIMESTAMP
                WHERE reference = ?
            `;
            
            const params = [...Object.values(updates), reference];
            
            this.db.run(sql, params, function(err) {
                if (err) {
                    console.error('Error updating transaction:', err.message);
                    reject(err);
                } else {
                    console.log('--- DB ACTION: Updated transaction ---');
                    console.log('Reference:', reference, 'Updates:', updates);
                    resolve(this.changes);
                }
            });
        });
    }

    async getTransaction(reference) {
        return new Promise((resolve, reject) => {
            const sql = `SELECT * FROM transactions WHERE reference = ?`;
            
            this.db.get(sql, [reference], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    close() {
        this.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            } else {
                console.log('Database connection closed');
            }
        });
    }
}

module.exports = new Database();
