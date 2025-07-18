// Healthcare Voice Agent - Express Server
// Implements Bot Framework integration with voice capabilities and patient data

const path = require('path');
const dotenv = require('dotenv');
const ENV_FILE = path.join(__dirname, '.env');
dotenv.config({ path: ENV_FILE });

const express = require('express');
const {
    CloudAdapter,
    ConfigurationBotFrameworkAuthentication
} = require('botbuilder');

const { EchoBot } = require('./bot');
const { PatientBotFactory } = require('./patientBotFactory');

// Initialize patient bot factory
const patientFactory = new PatientBotFactory();

// Create HTTP server with voice chat routing
const app = express();
app.use(express.json());

// Serve static files, excluding index.html to avoid routing conflicts
app.use(express.static(__dirname, {
    index: false,
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// Main voice chat interface
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'local-voice-chat.html'));
});

// WebChat interface
app.get('/webchat', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Patient management API endpoints
app.get('/api/patients', (req, res) => {
    try {
        const stats = patientFactory.getPatientStats();
        const patientsNeeding = patientFactory.getPatientsNeedingCalls();
        
        res.json({
            stats,
            patientsNeedingCalls: patientsNeeding.map(p => ({
                documentId: p.DocumentID,
                name: p.patientName,
                doctor: p.doctorName,
                dischargeDate: p.dischargeDate,
                medication: p.prescriptions[0]?.medicationName || 'N/A'
            }))
        });
    } catch (error) {
        console.error('[API] Error fetching patients:', error);
        res.status(500).json({ error: 'Failed to fetch patient data' });
    }
});

app.get('/api/patients/:documentId', (req, res) => {
    try {
        const patient = patientFactory.getPatientById(req.params.documentId);
        if (!patient) {
            return res.status(404).json({ error: 'Patient not found' });
        }
        
        res.json(patient);
    } catch (error) {
        console.error('[API] Error fetching patient:', error);
        res.status(500).json({ error: 'Failed to fetch patient data' });
    }
});

// Port configuration
const port = process.env.PORT || 3978;

// DirectLine token endpoint for local development
app.get('/api/directline/token', async (req, res) => {
    try {
        const response = {
            conversationId: 'local-' + Date.now(),
            token: 'development-token-' + Date.now(),
            expires_in: 3600,
            streamUrl: `ws://localhost:${port}/api/messages`
        };
        res.json(response);
    } catch (error) {
        console.error('Error generating DirectLine token:', error);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// Health check endpoint
app.get('/api/test', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Bot API is working',
        timestamp: new Date().toISOString()
    });
});

// Direct chat endpoint for API integration
app.post('/api/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;
        console.log('[API Chat] Received:', userMessage);
        
        if (!userMessage) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        const response = await myBot.processMessage(userMessage);
        console.log('[API Chat] Bot response:', response);
        
        res.json({ 
            response: response || 'I apologize, but I encountered an issue.',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[API Chat] Error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
});

// WebChat endpoint for backwards compatibility
app.post('/api/messages/conversations', async (req, res) => {
    try {
        console.log('[WebChat] Conversation request received');
        res.json({
            conversationId: 'webchat-' + Date.now(),
            token: 'mock-token',
            expires_in: 3600
        });
    } catch (error) {
        console.error('[WebChat] Error:', error);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

app.listen(port, () => console.log(`Bot is listening on port ${port}`));

const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(process.env);

const adapter = new CloudAdapter(botFrameworkAuthentication);

// Global error handler
const onTurnErrorHandler = async (context, error) => {
    console.error(`\n [onTurnError] unhandled error: ${ error }`);

    await context.sendTraceActivity(
        'OnTurnError Trace',
        `${ error }`,
        'https://www.botframework.com/schemas/error',
        'TurnError'
    );

    await context.sendActivity('The bot encountered an error or bug.');
    await context.sendActivity('To continue to run this bot, please fix the bot source code.');
};

adapter.onTurnError = onTurnErrorHandler;

// --- PATIENT DATA INTEGRATION ---
// For demo purposes, we'll create a bot instance for the first patient
// In production, you would create different bot instances for each patient call

console.log('\n=== Patient Bot Factory Initialization ===');
const patientStats = patientFactory.getPatientStats();
console.log('Patient Statistics:', patientStats);

// Select a patient for the demo (you can specify a name or get the next one)
const demoPatient = patientFactory.selectPatientForDemo(); // or pass a name: .selectPatientForDemo('Anjali')
const myBot = patientFactory.createBotForPatient(demoPatient);

console.log(`\n=== Bot Created for Patient ===`);
console.log(`Patient: ${demoPatient.patientName}`);
console.log(`Doctor: Dr. ${demoPatient.doctorName}`);
console.log(`Medication: ${demoPatient.prescriptions[0].medicationName} ${demoPatient.prescriptions[0].dosage}`);
console.log(`Discharge Date: ${new Date(demoPatient.dischargeDate).toLocaleDateString()}`);
console.log('=====================================\n');

// Main Bot Framework message endpoint
app.post('/api/messages', async (req, res) => {
    try {
        // Handle direct HTTP requests from voice chat interfaces
        if (req.body && req.body.text && req.body.type === 'message') {
            console.log('[Direct API] Received message:', req.body.text);
            
            try {
                const response = await myBot.processMessage(req.body.text);
                
                const botResponse = {
                    type: 'message',
                    text: response || 'I apologize, but I encountered an issue processing your request.',
                    from: { id: 'jenny_bot', name: 'Jenny' },
                    timestamp: new Date().toISOString()
                };
                
                console.log('[Direct API] Bot response:', botResponse.text);
                res.json(botResponse);
                
            } catch (botError) {
                console.error('[Direct API] Bot processing error:', botError);
                res.json({
                    type: 'message',
                    text: 'I apologize, but I encountered an error. Please try again.',
                    from: { id: 'jenny_bot', name: 'Jenny' },
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            // Process Bot Framework requests
            await adapter.process(req, res, (context) => myBot.run(context));
        }
    } catch (error) {
        console.error('[API] Error processing message:', error);
        res.status(500).json({
            type: 'message',
            text: 'I apologize, but I encountered an error. Please try again.',
            from: { id: 'jenny_bot', name: 'Jenny' },
            timestamp: new Date().toISOString()
        });
    }
});

// WebSocket upgrade handler for streaming
app.on('upgrade', async (req, socket, head) => {
    const streamingAdapter = new CloudAdapter(botFrameworkAuthentication);
    streamingAdapter.onTurnError = onTurnErrorHandler;
    await streamingAdapter.process(req, socket, head, (context) => myBot.run(context));
});
