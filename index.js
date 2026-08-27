import express from 'express';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.text({ type: '*/*' })); 

const sessions = new Map();

app.get('/sse', (req, res) => {
    const sessionId = uuidv4();
    console.log(`[${sessionId}] New SSE connection`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Inherit the GitHub PAT from the cloud environment variables
    const env = Object.assign({}, process.env);
    
    // Spawn the MCP server silently
    const child = spawn('npx', ['--silent', '-y', '@modelcontextprotocol/server-github'], { env });

    sessions.set(sessionId, child);

    // Determine the cloud URL for the POST endpoint
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
                    console.error(`Dropped non-JSON stdout: ${trimmed}`);
                }
            }
        }
    });

    child.stderr.on('data', (data) => {
        console.error(`[${sessionId}] Server log:`, data.toString().trim());
    });

    child.on('error', (err) => {
        console.error(`[${sessionId}] Child error:`, err);
    });

    child.on('close', (code) => {
        res.end();
        sessions.delete(sessionId);
    });

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
        child.stdin.write(req.body + '\n');
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
