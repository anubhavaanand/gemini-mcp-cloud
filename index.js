import express from 'express';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.text({ type: '*/*' })); 
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessions = new Map();

// --- MOCK OAUTH 2.0 FOR GEMINI SPARK ---

app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
    res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "client_credentials"]
    });
});

app.get('/authorize', (req, res) => {
    const redirectUri = req.query.redirect_uri;
    const state = req.query.state;
    if (redirectUri) {
        // Auto-approve and redirect back to Gemini
        res.redirect(`${redirectUri}?code=mock_auth_code&state=${state}`);
    } else {
        res.send('Authorized');
    }
});

app.post('/token', (req, res) => {
    res.json({
        access_token: "mock_access_token",
        token_type: "Bearer",
        expires_in: 360000
    });
});

// --- MCP SSE TRANSPORT ---

app.get('/sse', (req, res) => {
    const sessionId = uuidv4();
    console.log(`[${sessionId}] New SSE connection`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const env = Object.assign({}, process.env);
    
    // Spawn the MCP server silently
    const child = spawn('npx', ['--silent', '-y', '@modelcontextprotocol/server-github'], { env });

    sessions.set(sessionId, child);

    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const endpointUrl = `${protocol}://${host}/message?id=${sessionId}`;
    
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                try {
                    JSON.parse(trimmed);
                    res.write(`event: message\ndata: ${trimmed}\n\n`);
                } catch(e) {
                    // Ignore non-JSON stdout
                }
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`[${sessionId}] Server log:`, data.toString().trim());
    });

    child.on('close', () => res.end());
    req.on('close', () => {
        child.kill();
        sessions.delete(sessionId);
    });
});

app.post('/message', (req, res) => {
    const sessionId = req.query.id;
    const child = sessions.get(sessionId);

    if (!child) {
        return res.status(404).send('Session not found');
    }

    if (req.body) {
        const payload = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
        child.stdin.write(payload + '\n');
    }
    res.status(202).send('Accepted');
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cloud MCP Bridge running on port ${PORT}`);
});
