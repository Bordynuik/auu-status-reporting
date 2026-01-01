const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow overriding where runtime data (DB, logs) are stored.
const DATA_DIR = process.env.DATA_DIR || '/usr/src/app/data';

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const LOG_FILE = path.join(DATA_DIR, 'server.log');
const DB_FILE = path.join(DATA_DIR, 'auu.db');

// Simple logger function
function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite database
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        logToFile(`Error opening database: ${err.message}`);
    } else {
        logToFile('Connected to AUU_Query SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    const createTableSQL = `
        CREATE TABLE IF NOT EXISTS auu_queries (
            fqdn TEXT PRIMARY KEY,
            user_mail TEXT,
            user_password TEXT,
            start_date TEXT,
            end_date TEXT,
            parameters TEXT,
            comments TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        )`;

    db.run(createTableSQL, (err) => {
        if (err) {
            logToFile(`Error creating table: ${err.message}`);
        } else {
            logToFile('AUU queries table created or already exists.');
        }
    });
}

// Endpoint to get all FQDNs
app.get('/api/fqdns', (req, res) => {
    db.all('SELECT fqdn FROM auu_queries ORDER BY fqdn', [], (err, rows) => {
        if (err) {
            logToFile(`Error fetching FQDNs: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// Endpoint to get query data by FQDN
app.get('/api/query_data', (req, res) => {
    const { fqdn } = req.query;
    if (!fqdn) {
        return res.status(400).json({ error: 'FQDN is required' });
    }
    
    db.get('SELECT * FROM auu_queries WHERE fqdn = ?', [fqdn], (err, row) => {
        if (err) {
            logToFile(`Error fetching query data for FQDN ${fqdn}: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        if (row) {
            res.json(row);
        } else {
            res.json({
                fqdn: fqdn,
                user_mail: '',
                user_password: '',
                start_date: '',
                end_date: '',
                parameters: '',
                comments: ''
            });
        }
    });
});

// Endpoint to save/update query data
app.post('/api/save_query_data', (req, res) => {
    // Clear the log file at the start of each API execution
    fs.writeFileSync(LOG_FILE, '');

    const { fqdn, user_mail, user_password, start_date, end_date, parameters, comments } = req.body;
    logToFile(`Received query request: FQDN=${fqdn}, User Mail=${user_mail}, Parameters=${parameters}`);

    if (!fqdn) {
        return res.status(400).json({ error: 'FQDN is required' });
    }

    const sql = `
        INSERT INTO auu_queries (fqdn, user_mail, user_password, start_date, end_date, parameters, comments, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(fqdn) DO UPDATE SET
            user_mail = excluded.user_mail,
            user_password = excluded.user_password,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            parameters = excluded.parameters,
            comments = excluded.comments,
            last_updated = CURRENT_TIMESTAMP
    `;
    
    db.run(sql, [fqdn, user_mail, user_password, start_date, end_date, parameters, comments], function(err) {
        if (err) {
            logToFile(`Database save error for FQDN ${fqdn}: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        logToFile(`Query data saved successfully for FQDN ${fqdn}`);
        res.json({ message: 'Query data saved successfully' });
    });
});

// Endpoint to delete an FQDN entry
app.delete('/api/query_data/:fqdn', (req, res) => {
    const { fqdn } = req.params;
    db.run('DELETE FROM auu_queries WHERE fqdn = ?', [fqdn], function(err) {
        if (err) {
            logToFile(`Error deleting FQDN ${fqdn}: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            logToFile(`FQDN not found for deletion: ${fqdn}`);
            return res.status(404).json({ error: 'FQDN not found' });
        }
        logToFile(`FQDN entry deleted successfully: ${fqdn}`);
        res.status(200).json({ message: 'FQDN entry deleted successfully' });
    });
});

// Endpoint to handle AUU query execution
app.post('/api/execute_query', (req, res) => {
    fs.writeFileSync(LOG_FILE, '');

    const { fqdn, user_mail, user_password, start_date, end_date, parameters, comments, mimeType, timeout } = req.body;
    logToFile(`Received query request: FQDN=${fqdn}, User Mail=${user_mail}, Parameters=${parameters}`);

    if (!fqdn || !user_mail || !user_password || !parameters) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Save the current form data to database before executing query
    const saveSQL = `
        INSERT INTO auu_queries (fqdn, user_mail, user_password, start_date, end_date, parameters, comments, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(fqdn) DO UPDATE SET
            user_mail = excluded.user_mail,
            user_password = excluded.user_password,
            start_date = excluded.start_date,
            end_date = excluded.end_date,
            parameters = excluded.parameters,
            comments = excluded.comments,
            last_updated = CURRENT_TIMESTAMP
    `;
    db.run(saveSQL, [fqdn, user_mail, user_password, start_date || null, end_date || null, parameters, comments || null], function(err) {
        if (err) {
            logToFile(`Database save error before execution for FQDN ${fqdn}: ${err.message}`);
        } else {
            logToFile(`Query data saved/updated before execution for FQDN ${fqdn}`);
        }
    });

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

    logToFile(`API Request Options: ${JSON.stringify(options, null, 2)}`);
    // Create a safe copy of options for logging to avoid leaking credentials
    const safeOptions = { ...options, headers: { ...options.headers } };
    if (safeOptions.headers && safeOptions.headers.Authorization) {
        safeOptions.headers.Authorization = '[REDACTED]';
    }
    logToFile(`API Request Options: ${JSON.stringify(safeOptions, null, 2)}`);

    const apiReq = https.request(options, apiRes => {
        logToFile(`API Response Status: ${apiRes.statusCode}`);
        logToFile(`API Response Headers: ${JSON.stringify(apiRes.headers, null, 2)}`);
        
        let data = '';
        apiRes.on('data', chunk => {
            logToFile(`Received chunk: ${chunk.toString()}`);
            data += chunk;
        });
        apiRes.on('end', () => {
            try {
                const parsedData = JSON.parse(data);

                // Filter by start_date and end_date if provided
                let filteredData = parsedData;
                if (Array.isArray(parsedData) && start_date && end_date) {
                    const startEpoch = new Date(start_date).getTime();
                    const endEpoch = new Date(end_date).getTime();
                    filteredData = parsedData.filter(entry => {
                        const ts = entry.timestamp_epoch_ms;
                        return typeof ts === 'number' && ts >= startEpoch && ts <= endEpoch;
                    });
                }

                logToFile(`Filtered API Response (pretty):\n${JSON.stringify(filteredData, null, 2)}`);
                res.json(filteredData);
            } catch (parseError) {
                logToFile(`Failed to parse API response: ${parseError}`);
                logToFile(`Full API Response (raw): ${data}`);
                res.status(500).json({ error: 'Failed to parse API response', raw: data });
            }
        });
    });

    apiReq.on('error', error => {
        logToFile(`API request failed: ${error}`);
        res.status(500).json({ error: error.message });
    });

    apiReq.on('timeout', () => {
        logToFile('API request timed out');
        apiReq.destroy();
        res.status(408).json({ error: 'Request timeout' });
    });

    apiReq.end();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        database: 'Connected'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    logToFile(`Unhandled error: ${err.stack}`);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Gracefully close database connection
process.on('SIGINT', () => {
    logToFile('Shutting down server...');
    db.close((err) => {
        if (err) {
            logToFile(`Error closing database: ${err.message}`);
        } else {
            logToFile('Database connection closed');
        }
        process.exit(0);
    });
});

app.listen(PORT, '0.0.0.0', () => {
    logToFile(`Server is running on http://0.0.0.0:${PORT}`);
});