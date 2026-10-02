import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/faq-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manually load .env file
try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envFile.split('\n').forEach(line => {
        const i = line.indexOf('=');
        if (i < 1) return;
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key && value) process.env[key] = value;
    });
} catch (error) {
    console.log('No .env file found or error reading it');
}

// `node server.js --dry-run`: test the whole flow locally without e-mailing
// the owner or writing test leads into the real Google Sheet.
const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) {
    delete process.env.RESEND_API_KEY;
    delete process.env.SHEETS_WEBHOOK_URL;
}

const PORT = Number(process.env.PORT) || 8891;

// MIME types for different file extensions
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }



    // Handle API endpoint
    // Ignore ?query / #hash (e.g. the ?ajanlat deep link), like Vercel does.
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    if (pathname === '/api/faq-agent' && req.method === 'POST') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                // Parse body manually for local server
                req.body = JSON.parse(body || '{}');

                // Polymorph res to support Vercel/Express methods
                res.status = (code) => {
                    res.statusCode = code;
                    return res;
                };

                res.json = (data) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(data));
                    return res;
                };

                // Call the Vercel function
                await handler(req, res);

            } catch (error) {
                console.error('Error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer: 'Sorry, the server is acting up!' }));
            }
        });
        return;
    }

    // Serve static files from public directory
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}/`);
    if (DRY_RUN) console.log(`Dry run: no e-mails are sent and nothing is written to the Sheet.`);
    console.log(``);
});
