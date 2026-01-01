const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------------------------------
   Middleware
-------------------------------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* --------------------------------------------------
   PostgreSQL connection pool
-------------------------------------------------- */
const pool = new Pool({
    host: process.env.DB_HOST || 'db',
    database: process.env.DB_NAME || 'auu',
    user: process.env.DB_USER || 'auu_user',
    password: process.env.DB_PASSWORD || 'auu_password',
    port: 5432,
    ssl: false
});

/* --------------------------------------------------
   Simple request logging (optional but useful)
-------------------------------------------------- */
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url} from ${req.ip}`);
    next();
});

/* --------------------------------------------------
   Initialize database schema
-------------------------------------------------- */
async function initializeDatabase() {
    const sql = `
        CREATE TABLE IF NOT EXISTS auu_queries (
            fqdn TEXT PRIMARY KEY,
            user_mail TEXT,
            user_password TEXT,
            start_date TEXT,
            end_date TEXT,
            parameters TEXT,
            comments TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    await pool.query(sql);
}

initializeDatabase()
    .then(() => console.log('Database initialized'))
    .catch(err => {
        console.error('Database initialization failed:', err);
        process.exit(1);
    });

/* --------------------------------------------------
   API endpoints
-------------------------------------------------- */

// Get all FQDNs
app.get('/api/fqdns', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT fqdn FROM auu_queries ORDER BY fqdn'
        );
        res.json(rows);
    } catch (err) {
        console.error('Error fetching FQDNs:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get query data by FQDN
app.get('/api/query_data', async (req, res) => {
    const { fqdn } = req.query;
    if (!fqdn) {
        return res.status(400).json({ error: 'FQDN is required' });
    }

    try {
        const { rows } = await pool.query(
            'SELECT * FROM auu_queries WHERE fqdn = $1',
            [fqdn]
        );

        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.json({
                fqdn,
                user_mail: '',
                user_password: '',
                start_date: '',
                end_date: '',
                parameters: '',
                comments: ''
            });
        }
    } catch (err) {
        console.error(`Error fetching query data for ${fqdn}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Save/update query data
app.post('/api/save_query_data', async (req, res) => {
    const {
        fqdn,
        user_mail,
        user_password,
        start_date,
        end_date,
        parameters,
        comments
    } = req.body;

    if (!fqdn) {
        return res.status(400).json({ error: 'FQDN is required' });
    }

    try {
        await pool.query(
            `
            INSERT INTO auu_queries
            (fqdn, user_mail, user_password, start_date, end_date, parameters, comments, last_updated)
            VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
            ON CONFLICT (fqdn) DO UPDATE SET
                user_mail = EXCLUDED.user_mail,
                user_password = EXCLUDED.user_password,
                start_date = EXCLUDED.start_date,
                end_date = EXCLUDED.end_date,
                parameters = EXCLUDED.parameters,
                comments = EXCLUDED.comments,
                last_updated = CURRENT_TIMESTAMP
            `,
            [
                fqdn,
                user_mail,
                user_password,
                start_date,
                end_date,
                parameters,
                comments
            ]
        );

        res.json({ message: 'Query data saved successfully' });
    } catch (err) {
        console.error(`Database save error for ${fqdn}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Delete an FQDN entry
app.delete('/api/query_data/:fqdn', async (req, res) => {
    const { fqdn } = req.params;

    try {
        const result = await pool.query(
            'DELETE FROM auu_queries WHERE fqdn = $1',
            [fqdn]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'FQDN not found' });
        }

        res.json({ message: 'FQDN entry deleted successfully' });
    } catch (err) {
        console.error(`Error deleting ${fqdn}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Execute AUU query
app.post('/api/execute_query', async (req, res) => {
    const {
        fqdn,
        user_mail,
        user_password,
        start_date,
        end_date,
        parameters,
        comments,
        mimeType,
        timeout
    } = req.body;

    if (!fqdn || !user_mail || !user_password || !parameters) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Persist before execution
    try {
        await pool.query(
            `
            INSERT INTO auu_queries
            (fqdn, user_mail, user_password, start_date, end_date, parameters, comments, last_updated)
            VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
            ON CONFLICT (fqdn) DO UPDATE SET
                user_mail = EXCLUDED.user_mail,
                user_password = EXCLUDED.user_password,
                start_date = EXCLUDED.start_date,
                end_date = EXCLUDED.end_date,
                parameters = EXCLUDED.parameters,
                comments = EXCLUDED.comments,
                last_updated = CURRENT_TIMESTAMP
            `,
            [
                fqdn,
                user_mail,
                user_password,
                start_date || null,
                end_date || null,
                parameters,
                comments || null
            ]
        );
    } catch (err) {
        console.error('Pre-execution save failed:', err);
    }

    const options = {
        hostname: fqdn,
        path: parameters,
        method: 'GET',
        headers: {
            'Authorization': `Basic ${Buffer.from(`${user_mail}:${user_password}`).toString('base64')}`,
            'Accept': mimeType || 'application/json'
        },
        timeout: (timeout || 30) * 1000
    };

    const apiReq = https.request(options, apiRes => {
        let data = '';

        apiRes.on('data', chunk => {
            data += chunk;
        });

        apiRes.on('end', () => {
            try {
                const parsed = JSON.parse(data);

                let filtered = parsed;
                if (Array.isArray(parsed) && start_date && end_date) {
                    const startEpoch = new Date(start_date).getTime();
                    const endEpoch = new Date(end_date).getTime();
                    filtered = parsed.filter(entry => {
                        const ts = entry.timestamp_epoch_ms;
                        return typeof ts === 'number' &&
                               ts >= startEpoch &&
                               ts <= endEpoch;
                    });
                }

                res.json(filtered);
            } catch (err) {
                res.status(500).json({ error: 'Failed to parse API response', raw: data });
            }
        });
    });

    apiReq.on('error', err => {
        res.status(500).json({ error: err.message });
    });

    apiReq.on('timeout', () => {
        apiReq.destroy();
        res.status(408).json({ error: 'Request timeout' });
    });

    apiReq.end();
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'OK', database: 'Connected' });
    } catch {
        res.status(500).json({ status: 'ERROR', database: 'Disconnected' });
    }
});

/* --------------------------------------------------
   Graceful shutdown
-------------------------------------------------- */
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await pool.end();
    process.exit(0);
});

/* --------------------------------------------------
   Start server
-------------------------------------------------- */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});
